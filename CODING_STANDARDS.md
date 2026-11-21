# Coding standards

Judgement-call rules for review. Anything a check can enforce (lint, typecheck, the schema-invariant test) lives in that check, not here. Each rule names the line to flag.

## Tests assert facts

Assert tool calls, error codes, ticket state and Dashboard state. Wording belongs to the Agent and the prompt, and both change freely.

Flag: an assertion on reply text, prompt text, `guidance` text or an error message (`toMatch`/`toContain` on a sentence). Assert the structured field instead: `locked`, `attemptsRemaining`, `code`, `ticketAction`. When the fact is "the model was told X", assert that a system note was queued, not what it says.

Source: the spec's Testing Decisions.

## Every query is scoped by session

Every SQL read and write filters on `session_id`: reads, updates by primary key, deletes, joins, and the `DO UPDATE` clause of an upsert. A primary key alone is not a scope.

Flag: any statement against a session table whose `WHERE` (or `ON CONFLICT … DO UPDATE … WHERE`) lacks `session_id = $n`.

Source: ADR-0001. A missed scope leaks one visitor's data into another's Demo Session.

## Raw-SQL test fixtures need a reason

Create test state through the service. Reach for raw SQL only when the service cannot produce that state, and put a comment above it saying why.

Expected values are worked out by hand from the seed data or the spec, as literals. A value copied from the production query passes by construction.

Flag: a raw `INSERT`/`UPDATE` in a test with no comment, and an expected value built by the code under test.

## Glossary terms in code and UI

Names, copy and comments use the `GLOSSARY.md` term (Customer, Engineer, Operator, Visit, Handoff Ticket), never its `_Avoid_` alternatives.

Flag: an `_Avoid_` word in an identifier, UI string or comment.
