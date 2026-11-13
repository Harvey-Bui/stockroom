# Stockroom: restaurant inventory with an AI assistant

A web app for the kitchen. It shows inventory and deliveries, and has a chat assistant, **Basil**, that answers questions in plain English from your inventory database. Basil can also record counts, usage and deliveries, but only after someone taps **Approve**.

- **Inventory**: every item with on-hand amount, status, supplier and last delivery. Filter, search, or tap **Ask** on any row.
- **Deliveries**: each invoice with its lines. Short shipments are flagged. Managers also see costs.
- **Activity log** (managers): every change Basil was asked to make, including cancelled and rejected ones.
- **Basil**: a chat panel on every page (full-screen on phones), with suggested questions to start from.

Stack: Next.js 16 on Vercel · Neon Postgres · Google Gemini (free tier) or Claude.

---

## Deploy to Vercel

You need free accounts with **Vercel** and **Google** (for a free Gemini key, no card). Neon is created for you by Vercel in step 3.

### 1. Install the tools
Install Node.js 20 or newer from nodejs.org. Then open a terminal in this folder:
```
npm install
```

### 2. Create the Vercel project
```
npx vercel link
```
Log in when asked. Answer **yes** to "set up and link", pick your account, and choose **no** for linking an existing project. Accept the suggested name (or type one) and the default settings.

### 3. Add the database
On vercel.com, open the project → **Storage** → **Create Database** → **Neon** (Serverless Postgres) → pick a region near you → **Create**. Connect it to the project for all environments.
This adds `DATABASE_URL` to the project's settings automatically.

### 4. Add the other settings
Go to **Settings → Environment Variables** and add each of these for **Production, Preview and Development**:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | free key from **aistudio.google.com/apikey** (starts `AIza…`). Or set `ANTHROPIC_API_KEY` instead to use Claude. |
| `SESSION_SECRET` | random text, 32+ characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `STAFF_PASSCODE` | the passcode kitchen staff will sign in with (8+ characters) |
| `MANAGER_PASSCODE` | the passcode managers will sign in with (different from staff) |
| `RESTAURANT_NAME` | optional, shown in the app (e.g. `La Cocina`) |
| `APP_TIMEZONE` | optional, defaults to `America/Chicago` |

### 5. Deploy
```
npx vercel --prod
```
The build creates the tables, loads the spreadsheet data on the first run, and sets up the database's read-only logins. Then it builds the site. When it finishes, open the URL it prints and sign in with your name and a passcode.

**Later updates:** change the code, then run `npx vercel --prod` again. Your data is kept: the seed only runs into an empty database. If you'd rather deploy on every push, put the folder in a GitHub repo and connect it under the project's **Settings → Git**.

> If you change `SESSION_SECRET`, redeploy so the read-only database passwords are updated too. Everyone will have to sign in again.

---

## How the assistant stays accurate and safe

```
message ─► /api/chat ─► Gemini or Claude (role-aware system prompt + schema + live data summary)
                          │ query_inventory(sql) ─► role's READ-ONLY database login ─► rows
                          │ record_* / set_*     ─► validate ─► Approve/Cancel card ─► write + audit row
                          ▼
                       answer (direct sentence, table when useful, "Checked N records" detail)
```

- **Answers come from rows, not guesses.** On-hand stock is derived: the last physical count, plus deliveries, minus usage since then. Items with no count show **Not counted**, and Basil says so instead of treating a delivery as stock. Every turn, Basil is also told what the database is missing (counts, thresholds, expiry dates, supplier contacts).
- **The database enforces the roles.** Basil's queries run as one of two Postgres logins created by `scripts/setup.mjs`:
  - `stockroom_staff_ro` can only see the `staff_ro` schema, which has the same views but no cost columns, no audit log and no chats.
  - `stockroom_manager_ro` can see inventory tables, costs and the audit log, but not chats or pending changes.

  Both logins are read-only by default, have a 5-second statement timeout, and run inside a `READ ONLY` transaction. The query is wrapped so it can only be a single `SELECT` capped at 200 rows.
- **Writes are typed actions, never SQL.** A change is validated first: the item must exist, the unit must match, and numbers can't be negative. A card then shows exactly what will change. Nothing is saved until the person taps **Approve**. The change and its audit row commit together. Cancelled, rejected and expired requests are logged too.
- **Sessions** are signed, HTTP-only cookies lasting 12 hours. Chats are stored per user and can't be opened by anyone else.

| Role | Can see | Can change (with approval) |
|---|---|---|
| Staff | items, stock, suppliers, deliveries (no prices) | stock counts, usage/waste |
| Manager / admin | everything above plus costs and the activity log | plus deliveries, thresholds, expiry dates, supplier contacts |

## What the current data can answer

The seed (`seed/inventory.json`, taken from your spreadsheet) has 56 items, 2 suppliers and one invoice each. It has no on-hand counts, thresholds, expiry dates, usage history or supplier contacts.

| Question | Today |
|---|---|
| Who supplies X, when did it last arrive, how much did we buy, what did we spend, what was short-shipped | ✅ |
| How much X do we have | after a count is recorded ("we have 3 bags of rice") |
| What's running low | after counts **and** thresholds ("set rice minimum to 2") |
| What expires soon | after expiry dates are recorded on deliveries/lots |
| Enough X for N days | after counts plus some usage history |

## Run locally

```
cp .env.example .env.local      # fill in DATABASE_URL (Neon → Connection string) and the rest
npm install
npm run setup                   # schema + seed + read-only logins
npm run dev                     # http://localhost:3000
```

### Tests
`tests/e2e.mjs` runs 13 end-to-end checks against a running app. It uses `tests/mock-anthropic.mjs`, a scripted stand-in for both the Claude API and Gemini's OpenAI-compatible endpoint, so no key is needed. The checks cover logins, role-filtered pages, SQL injection attempts, the approve/cancel flow, chat privacy and the audit log. **Use a throwaway database**, because the tests record counts.

```
node tests/mock-anthropic.mjs &
GEMINI_API_KEY=x GEMINI_BASE_URL=http://127.0.0.1:4010 npm run build && GEMINI_API_KEY=x GEMINI_BASE_URL=http://127.0.0.1:4010 npm start &
BASE=http://127.0.0.1:3000 STAFF_PASSCODE=… MANAGER_PASSCODE=… node --test tests/e2e.mjs
```

## Project layout

| Path | Purpose |
|---|---|
| `db/schema.sql` | Tables, the three views (`v_current_stock`, `v_purchase_history`, `v_expiring_lots`) and the cost-free `staff_ro` schema |
| `scripts/setup.mjs` | Idempotent setup: schema, seed (empty DB only), read-only logins and grants. Runs before every build. |
| `lib/tools.ts` | Read tool and the typed write actions (validate → apply + audit) |
| `lib/agent.ts` | System prompt, tool definitions, tool loop, and the pending-approval flow |
| `lib/llm.ts` | Model adapter: Gemini (OpenAI-compatible endpoint) or Claude, chosen by which key is set |
| `lib/db.ts`, `lib/session.ts`, `lib/config.ts` | Connections, signed sessions, settings |
| `app/(app)/…` | Inventory, Deliveries and Activity pages |
| `components/Assistant.tsx` | The Basil chat panel |

## Good next steps
- **Per-person logins**: shared passcodes are fine to start with. For real staff accounts, swap `lib/session.ts` for Clerk or Auth.js; nothing else needs to change.
- **Rate limiting** on `/api/login` and `/api/chat` (Vercel Firewall rules or Upstash).
- **Free-tier limits**: Gemini's free tier caps requests per minute and per day, and Google may use free-tier prompts to improve its products. For real use, add billing in AI Studio or switch to `ANTHROPIC_API_KEY`.
- **Usage from the POS**: import daily sales × recipe quantities as `usage` records, so "enough for N days" and reorder suggestions work on their own.
- **Streaming replies**, so long answers appear word by word.
