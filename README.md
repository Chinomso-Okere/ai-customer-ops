# Apex Heating & Cooling: Agentic Customer Operations Demo

A split-screen demo: a fake Apex website with a chat widget (left) and the live
Operations Dashboard (right). Every visitor gets a private, freshly seeded
**Demo Session** (ADR-0001). Vocabulary follows [`GLOSSARY.md`](GLOSSARY.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Test (Vitest, in-process Postgres via PGlite) | `npm test` |
| Lint (ESLint, Next.js config) | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Dev server (http://localhost:3000) | `npm run dev` |
| Dev server, no API key (scripted Agent) | `AGENT_MODEL=scripted npm run dev` |
| Production build | `npm run build` |
| Eval suite (real model, costs money) | `npm run eval` |

Node 22+ is required. Without `DATABASE_URL`, the app uses an in-memory PGlite
database, so local dev needs no Postgres (data resets when the server restarts).
In production, set `DATABASE_URL` to Neon; migrations run on first request. See
`.env.example`.

## Layout

```
src/
  domain/              Pure domain vocabulary and rules (Issue Types, statuses,
                       Time Windows, London dates, Coverage Area). No I/O.
  server/
    demo-session/      The Demo Session service: the deep module and the only
                       thing the web layer calls (Seam 1). Seed world lives here.
    agent/             The Agent runner: manual tool loop, system prompt + Price
                       List, conversation and Agent Trace persistence.
      tools/           Domain tools, one per file, listed in tools/index.ts.
      hooks/           Pre-model hooks (run before the model on every Customer
                       message), listed in hooks/index.ts.
    db/                Database interface, PGlite and pg adapters, migrations.
    clock.ts           Injected clock.
    model-client.ts    Injected model client (Claude Sonnet 5.5 adapter).
    runtime.ts         Wires the service for the running app.
    testing/           Seam 1 harness and the scripted fake model client.
  evals/               Eval suite: real-model scenarios over Seam 1 (`npm run eval`).
  app/                 Next.js App Router: page + thin API routes.
  components/          Thin UI over the dashboard state.
```

## Conventions

- **Test through the Demo Session service.** Build it with `createHarness({ now })`
  from `src/server/testing/harness.ts`. It uses a real in-process Postgres and no
  repository mocks. Assert on returned state, never on SQL rows. Use `london("2026-11-18T11:30")`
  for readable pinned times.
- **Scope everything by Demo Session.** Every domain table has `session_id`, and
  every query filters on it, including joins.
- **Schema changes:** append a new entry to `src/server/db/migrations.ts`. Never
  edit a deployed migration.
- **Business timezone is Europe/London.** Calendar dates are `PlainDate`
  strings (`"YYYY-MM-DD"`); read `date` columns with `::text`.

## The Agent

`sendCustomerMessage` runs one Customer turn: pre-model hooks, then a manual
tool loop on Claude Sonnet 5.5 (`src/server/agent/runner.ts`).

- **Add a domain tool:** create `src/server/agent/tools/<name>.ts` exporting an
  `AgentTool` (strict `inputSchema`, a description that says *when* to call it,
  `run(input, ctx)` that validates and enforces policy and returns
  `{ ok: true, result }` or `{ ok: false, error }`), then add it to
  `tools/index.ts`. The runner records every call in the Agent Trace.
  Strict tool use emits optional properties in schema order, so a tool whose
  inputs vary by case (like `verify_customer`) should make every field
  required and nullable (`type: ["string", "null"]`) rather than optional.
- **Turn limits:** at most 8 model calls per Customer turn. If the same tool
  call (name and input) fails the same way twice in a turn, the second result
  tells the model not to repeat it; a third ends the turn with the apology.
- **Tell the model about state** (e.g. an open Emergency ticket): call
  `ctx.enqueueSystemNote(text)` from a tool or hook. The note reaches the model
  as a mid-conversation system message right after the next Customer message.
  Never edit the system prompt or earlier messages: the history is append-only
  and the system prompt is a cached, byte-stable prefix.
- **Act before the model:** add a `PreModelHook` to `hooks/index.ts`. Return
  `{ replies, historyNote }` to handle the turn without calling the model.
- **Tests:** `createHarness({ now })` returns `model`, a `ScriptedModelClient`.
  Script each model call with `model.script(reply([text(...), toolCall(...)]))`.
  It rejects histories the real API would reject.
- **Fallbacks:** requests use `fallbacks: "default"`. A live check showed that
  this works with mid-conversation system messages. If a real fallback hits a
  model that rejects them (a 400), the adapter retries once without fallbacks.
  See `src/server/model-client.ts`.

Set `ANTHROPIC_API_KEY` to chat; without it, the Agent replies with an apology.

**Scripted dev mode (no paid key).** `AGENT_MODEL=scripted npm run dev` swaps
the model for a small keyword router (`src/server/testing/dev-scripted-model.ts`)
so you, or an agent driving a browser, can click through the scenario tray:
Price List questions, Availability, a proposed and confirmed Booking,
verifying a demo-friendly Customer and looking up their Job, and a refund
request (Handoff Ticket). The gas scenario is caught by the Emergency
pre-filter before any model. It is not a model: wording is canned and
anything off-script gets a help message. It is dev only: a production build
does not contain it and refuses to serve while `AGENT_MODEL=scripted` is set.
Never use the real key to check the UI; use this. See `docs/agents/extending.md`.

## Guardrails

Cost and abuse limits for the public URL (#7):

- **Message cap:** 40 Customer messages per Demo Session, across all its
  conversations (`MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION`, pre-model hook
  `src/server/agent/hooks/message-cap.ts`). Past the cap the Agent sends a fixed
  `message_cap` reply without calling the model, and the chat offers
  "Start a new demo". Keep the cap hook last in `hooks/index.ts` so the Emergency
  pre-filter still runs past the cap.
- **New-session rate limit:** at most 10 new Demo Sessions per client IP per
  rolling hour (`MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR`). Only new sessions count;
  resuming a live one does not. "Reset demo" and "Start a new demo" replace the
  session instead of adding one: `service.resetDemoSession` deletes the visitor's
  own session (the one in their cookie, never one found by IP) with all its data
  and creates the new one in one transaction, so resets never hit the limit.
  If a reset is refused (no live session in the cookie and the IP is at the
  limit), nothing is deleted and the notice shows next to the Reset button and
  in the chat. The API answers `429 { error: "rate_limited" }`
  and the page shows a friendly "try again later". The IP comes from
  `x-forwarded-for`, and only a salted SHA-256 hash is stored
  (`demo_session.client_ip_hash`). Expired sessions still count until cleanup
  deletes them. That is fine because the TTL (4 h) is longer than the window.
- **Monthly API spend cap:** set in the Anthropic Console (deploy ticket).

### Expired-session cleanup

`service.deleteExpiredDemoSessions()` deletes every Demo Session past its TTL
together with all its data. Every session-scoped table must reference
`demo_session(id) ON DELETE CASCADE`. Expired sessions are already unreachable,
so cleanup only frees storage.

In production it runs from Vercel Cron: `vercel.json` calls
`GET /api/cron/cleanup-expired-sessions` daily at 04:00 UTC. The Hobby plan
allows only daily cron jobs. On Pro you can change the schedule to hourly
(`0 * * * *`). To enable it at deploy time (#9):

1. In Vercel → Project → Settings → Environment Variables (Production), set
   `CRON_SECRET` to a long random string (e.g. `openssl rand -hex 32`). Vercel
   sends it as `Authorization: Bearer <CRON_SECRET>`. Without it the endpoint
   answers 401 to every request.
2. Set `DEMO_SESSION_IP_SALT` to another long random string.
3. Deploy. Check that Project → Settings → Cron Jobs lists the job, then click
   **Run** once and confirm the response is `{ "deleted": <n> }`.

## Eval suite

`npm run eval` runs about 20 scripted multi-turn Customer conversations
(`src/evals/scenarios.ts`) through the Demo Session service with the **real**
model (Claude Sonnet 5.5, via `AnthropicModelClient`). Each scenario gets a
fresh Demo Session with a pinned clock (Wednesday 18 November 2026, 09:30
London, unless the scenario sets its own) and checks **facts only**: which
tools appear in the Agent Trace and with what outcome, and the resulting
dashboard state (Jobs, Visits, Handoff Tickets, possible duplicates). It never
checks reply wording. Every scenario also fails if the Agent errored (e.g. an
API 400).

- **Run it manually before a deploy**, not in CI: it calls the paid API.
  `npm test` never runs it (its files are `*.eval.ts`, outside the default
  `*.test.ts` pattern; the suite has its own `vitest.eval.config.ts`).
- **Needs `ANTHROPIC_API_KEY`** in the shell or in `.env.local`. Without it the
  command stops at once with a message and makes no calls.
- **Cost:** about 120 model calls per full run (roughly 46 Customer turns),
  most of the prompt served from the cache. Expect **about $1-2** per run at
  Sonnet 5.5 list prices. The report ends with the actual token counts and an
  estimated cost. A full run takes a few minutes (4 scenarios at a time).
- **One scenario:** `npm run eval -- -t gas-leak` (Vitest name filter).
- **Report:** one `PASS`/`FAIL` line per scenario. For each failure it lists
  the facts that did not hold, what was observed, and the tool calls in order.
  The model is not deterministic (temperature can't be set on this API
  version), so rerun a failing scenario once before treating it as a
  regression. If it fails again, file an issue.

Adding a scenario: append to `SCENARIOS` with Customer `steps` (strings, or
functions of the world, e.g. to quote a seeded Job Reference; `operator` steps
act on the dashboard between turns) and `expect` facts built from
`src/evals/facts.ts`. Give Customers' details up front and assert the end state,
so any reasonable path the model takes passes. `src/evals/scenarios.test.ts`
(part of `npm test`, scripted model) checks that every scenario fails against
an Agent that does nothing, unless the server guarantees its facts (e.g. the
gas-leak pre-filter). It also checks that each scenario passes against a
scripted Agent doing the right thing. Add a played-Agent case there for each
new scenario.
