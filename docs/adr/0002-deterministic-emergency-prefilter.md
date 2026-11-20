# Deterministic Emergency pre-filter runs before the LLM

Every Customer message passes through a deterministic phrase matcher ("smell gas", "gas leak", "CO alarm", "carbon monoxide", "water pouring", "flooding", "sparks") before the Agent sees it. On a match, the system shows the fixed Safety Script and creates a Critical Handoff Ticket itself. We rejected leaving Emergency detection to the model's judgment through an `escalate` tool, because a safety-critical path must not be probabilistic. The LLM still escalates Complaints and Out of Policy requests, and it may raise an Urgency but never lower one.

## Consequences

- When unsure, the matcher fails toward firing. A negation only suppresses a match if it comes directly before the phrase ("no gas smell", "not flooding"). Hedges such as "might", "think", or "maybe" never suppress it. A false alarm costs one ticket; a miss could cost a life.
- The matcher is plain code with a table-driven test suite of phrasings, and it must stay that way. Don't "upgrade" it to an LLM classifier without revisiting this ADR.
