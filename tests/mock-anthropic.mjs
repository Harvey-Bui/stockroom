// Scripted stand-in for the Anthropic Messages API and Gemini's OpenAI-compatible
// /chat/completions endpoint, for end-to-end tests without a key.
//   "SQL: <query>"           -> model calls query_inventory with that SQL
//   "WRITE: <tool> <json>"   -> model calls that write tool
//   anything else            -> plain text reply
// After a tool result, the model replies "RESULT: <tool result JSON>".
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const port = Number(process.env.MOCK_PORT || 4010);
let n = 0;
const reply = (content, stop) => ({ id: `msg_${++n}`, type: "message", role: "assistant", model: "mock",
  content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const openai = req.url.includes("chat/completions");
    // MOCK_HANG=model → never answer for that model (tests time limits)
    if (openai && (process.env.MOCK_HANG || "").split(",").includes(b.model)) return;
    // MOCK_UNAVAILABLE=model1,model2 → answer 503 for those models (tests fallback)
    if (openai && (process.env.MOCK_UNAVAILABLE || "").split(",").includes(b.model)) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify([{ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }]));
    }
    let text, results;
    if (openai) {
      // Normalise to: trailing tool messages = results, trailing user message = text
      const tail = [];
      for (let i = b.messages.length - 1; i >= 0 && b.messages[i].role !== "assistant"; i--) tail.unshift(b.messages[i]);
      results = tail.filter((m) => m.role === "tool").map((m) => ({ content: m.content }));
      text = tail.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      writeFileSync("/tmp/mock-last-request.json", JSON.stringify({ system: b.messages[0].content, messages: b.messages, model: b.model }, null, 1));
    } else {
      writeFileSync("/tmp/mock-last-request.json", JSON.stringify(b, null, 1));
      const last = b.messages.at(-1);
      const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      text = blocks.filter((x) => x.type === "text").map((x) => x.text).join("\n");
      results = blocks.filter((x) => x.type === "tool_result");
    }
    let out;
    if (text.startsWith("SQL:")) {
      out = reply([{ type: "text", text: "Checking." }, { type: "tool_use", id: `tu_${n}`, name: "query_inventory",
        input: { sql: text.slice(4).trim(), purpose: "test" } }], "tool_use");
    } else if (text.startsWith("WRITE:")) {
      const [, tool, ...rest] = text.split(" ");
      out = reply([{ type: "text", text: "I'll record that." }, { type: "tool_use", id: `tu_${n}`, name: tool,
        input: JSON.parse(rest.join(" ")) }], "tool_use");
    } else if (results.length && !text) {
      out = reply([{ type: "text", text: "RESULT: " + results.map((r) => r.content).join(" | ") }], "end_turn");
    } else {
      out = reply([{ type: "text", text: `echo: ${text}` }], "end_turn");
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (openai) {
      const tc = out.content.filter((c) => c.type === "tool_use");
      out = { id: out.id, object: "chat.completion", model: b.model, choices: [{ index: 0,
        finish_reason: tc.length ? "tool_calls" : "stop",
        message: { role: "assistant", content: out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || null,
          ...(tc.length ? { tool_calls: tc.map((c) => ({ id: c.id, type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) } }] };
    }
    res.end(JSON.stringify(out));
  });
}).listen(port, () => console.log(`mock anthropic on :${port}`));
