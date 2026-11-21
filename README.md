# Apex Heating & Cooling: Agentic Customer Operations Demo

A split-screen demo: a fake Apex website with a chat widget (left) and the live
Operations Dashboard (right). Every visitor gets a private, freshly seeded
**Demo Session** (ADR-0001). Vocabulary follows [`GLOSSARY.md`](GLOSSARY.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Test (Vitest, in-process Postgres via PGlite) | `npm test` |
| Typecheck | `npm run typecheck` |
| Dev server (http://localhost:3000) | `npm run dev` |
| Production build | `npm run build` |

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
