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
    db/                Database interface, PGlite and pg adapters, migrations.
    clock.ts           Injected clock.
    model-client.ts    Injected model client (placeholder until Agent chat, #3).
    runtime.ts         Wires the service for the running app.
    testing/harness.ts Seam 1 harness: real service, in-process Postgres, pinned clock.
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
