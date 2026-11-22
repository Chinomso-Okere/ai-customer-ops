# Extending the codebase

Each extension point is a registry: write the module, add one import and one
line to the registry file. `README.md` ("The Agent", "Conventions") already
covers adding a domain tool, a pre-model hook, system notes, migrations and the
`date`/`::text` rule; read it first. This file holds the rest.

## Add a pre-model hook

Register it in `PRE_MODEL_HOOKS` (`src/server/agent/hooks/index.ts`). Order is
the contract: the first hook that returns an outcome ends the turn.
`emergencyPrefilter` stays first so a Safety Script shows even past the cap;
`messageCapHook` stays last so every other hook still runs. Insert yours
between them.

## Add a pending-action kind (two-phase Confirmation)

A write tool never writes. It validates, then returns `proposeAction(ctx, kind,
{ payload, readBack, guidance })`, which records the proposal and yields the
outcome with the read-back; `confirm_action` runs the write once a later
Customer message arrives.

1. Define a `PendingActionKind` (`src/server/agent/confirmation/pending-actions.ts`)
   in its own file beside `booking.ts`, and list it in `PENDING_ACTION_KINDS`
   (`confirmation/index.ts`).
2. `execute(tx, ctx, payload)` runs some time after the proposal: re-check what
   may have changed (Availability, the 24h rule). Return `ok: false` to roll
   back every write.
3. Set `allowedDuringGasEmergency: true` only for a write that books nothing (a
   cancellation). Every other kind is refused while a gas/CO Emergency ticket is
   open anywhere in the Demo Session (a New chat does not escape it). Wrap its propose tool in `blockedDuringGasEmergency(...)` in
   `tools/index.ts` unless the kind has that exemption.
4. Set `bindsChatCustomer: true` for a write that creates or uses a Customer
   from details the Customer typed (only `booking`). `proposeAction` and
   `confirm_action` then refuse details naming someone other than the chat's
   Customer (`one_customer_per_chat`, #27) and, once the write succeeds, make
   its Customer the chat's (`src/server/chat-customer`). The payload must carry
   `fullName`, `postcode` and `email`. Don't set it on writes for an already
   verified Job, nor on `emergency_visit`: an Emergency Visit is never refused
   for who it is for.

## Add a chat reply kind

1. Add the kind (with its `payload` shape in the comment) to `ChatMessageKind`
   in `src/server/agent/types.ts`.
2. Style `.bubble--<kind>` in `src/app/globals.css`; `ChatWidget.tsx` already
   puts every kind's class on the bubble.
3. A kind with a structured `payload` also needs its own render branch in
   `src/components/ChatWidget.tsx` (see `safety_script`).
4. Assert it in evals with `replied(kind)` (`src/evals/facts.ts`).

## Add a migration

Append it to the `migrations` array in `src/server/db/migrations.ts`. Every new
table needs `session_id uuid NOT NULL REFERENCES demo_session(id) ON DELETE
CASCADE`, so resetting a Demo Session removes its rows.
`src/server/db/schema-invariants.test.ts` enforces both the cascade and that
migration ids are unique and increasing, so a collision between branches fails
the test.

## Escalation state for the model

Per `README.md`, queue it with `ctx.enqueueSystemNote(text)`. When the server
must also refuse (not just advise), enforce the rule in code, as
`gasEmergencyBookingBlock` does (`src/server/agent/emergency.ts`): the note is
advice, the block is the guarantee.

## Add detail to an open Handoff Ticket

Later facts reach an open ticket through the same `create_handoff_ticket` call
(a repeat with the same reason appends; no second tool). Contact details are the
example: `customerName` and `customerPhone` (required, nullable) fill
`handoff_ticket.contact_name` / `contact_phone` via `raiseHandoffTicket`, which
only ever fills a missing value, and the timeline gets an `appended` event. A
phone goes through `normaliseUkPhone` (`src/domain/uk-phone.ts`) and junk is
refused with `code: "invalid_phone"`, nothing saved.

The fixed Emergency notice reads the ticket afterwards: its `handoff_notice`
payload carries `contactNeeded`, which is true until both fields are set, so a
repeat Emergency message asks again. Wording stays in code
(`emergencyNotice` in `hooks/emergency-prefilter.ts`); tests assert the payload.

## Test helpers

- `createHarness({ now })` (`src/server/testing/harness.ts`) returns `service`,
  `clock`, `model` and `db`. Domain tickets run through the real registries;
  override `agentTools` or `preModelHooks` only to test the runner's own
  mechanics.
- `chatHarness(now)`, `toolTurn(h, customerText, toolName, input)` and
  `toolTurns(h, customerText, calls)` (`src/server/testing/tool-turns.ts`) run
  one Customer turn in which the scripted model calls the tool(s), and return
  what the tool sent the model. Prefer them to hand-written scripts for tool
  tests.
- `ScriptedModelClient`, `reply`, `text`, `toolCall`, `refusal` and
  `lastToolResults` live in `src/server/testing/scripted-model-client.ts`.
- One PGlite database is shared per test file: assert per Demo Session, never
  on global counts.

## Check the chat UI without the paid key

`AGENT_MODEL=scripted npm run dev` (leave `ANTHROPIC_API_KEY` unset) runs the app
with `DevScriptedModelClient` (`src/server/testing/dev-scripted-model.ts`), a
keyword router over the conversation, not a model. Use it, never the real key,
to check a chat flow in a browser. Drive it by clicking the scenario tray, or
over HTTP: `POST /api/demo-session`, `POST /api/conversation`, then
`POST /api/conversation/messages` with `{ "text": ... }`, keeping the cookies
(`apex_demo_session`, `apex_conversation`).

- **Covers:** Price List answers, `get_availability`, `propose_booking` then
  `confirm_action`, `verify_customer` then `get_job_details`, and
  `create_handoff_ticket` for complaints and refunds. Gas/CO is the pre-model
  hook, so it needs no model.
- **Routing is stateless:** it reads the customer's words and the tool results
  already in the request, so it keeps no state of its own. Add a behaviour in
  `startTurn` (what to call) and `afterTool` (what to say) in that file, and a
  test in `src/server/demo-session/dev-scripted-model.test.ts`, which drives the
  real Agent through the Demo Session service.
- **Restart the dev server after editing it:** the model client is cached on
  `globalThis` across hot reloads.
- **Dev only, enforced twice:** `src/server/runtime.ts` imports it behind
  `process.env.NODE_ENV !== "production"`, which the production build inlines,
  so the file is not in the bundle; and with `NODE_ENV=production` the setting
  throws instead of being ignored (`src/server/runtime.test.ts`). Keep any new
  import of it behind the same check.

## Gotchas

- **Serialise session writes with `lockDemoSession(tx, sessionId)`**
  (`src/server/db/session-lock.ts`), called inside the transaction before the
  write. It is the single per-session lock for scheduling and Handoff Ticket
  numbering; nested writes re-enter it. A second lock risks deadlock.
- **Tool refusals carry a `code`** (`ToolErrorCode` in `types.ts`; shared
  entries in `TOOL_ERRORS`). Tests assert `code`, so the `error` wording can
  change freely.
- **Optional fields in strict tool schemas** are emitted in schema order, so
  make them required and nullable; see "Add a domain tool" in `README.md`.
- **Email comparisons** use `sqlEmailEquals(column, param)` from
  `@/server/verification`.

## After pushing

Check the Vercel deployment:

```
gh api repos/Chinomso-Okere/ai-customer-ops/commits/<sha>/status
```
