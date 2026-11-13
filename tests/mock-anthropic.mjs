// Scripted stand-in for the Anthropic Messages API, for end-to-end tests without a key.
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
    writeFileSync("/tmp/mock-last-request.json", JSON.stringify(b, null, 1));
    const last = b.messages.at(-1);
    const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    const text = blocks.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    const results = blocks.filter((x) => x.type === "tool_result");
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
    res.end(JSON.stringify(out));
  });
}).listen(port, () => console.log(`mock anthropic on :${port}`));
