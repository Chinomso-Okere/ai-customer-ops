/**
 * Fact builders for eval scenarios: checks on the Agent Trace (which tools
 * were called, with what outcome) and on dashboard state. None of them look
 * at reply wording.
 */
import type { ChatMessageKind } from "@/server/agent";
import type { AgentTraceEntry } from "@/server/agent/conversation-store";
import type { DashboardHandoffTicket, DashboardJob } from "@/server/demo-session";
import type { EmergencyKind } from "@/domain/emergency-prefilter";
import type { EvalWorld, Fact } from "./scenario";

/** A tool call from the trace, with its result parsed when it was a success. */
export interface ToolCall {
  name: string;
  input: Record<string, any>;
  ok: boolean;
  /** Parsed JSON result on success; the error text on failure. */
  result: any;
  /** Index of the Customer turn it happened in (0-based). */
  turn: number;
}

export function toolCalls(w: EvalWorld, name?: string): ToolCall[] {
  return w.turns.flatMap((entries, turn) =>
    entries
      .filter((e) => e.kind === "tool_call" && (!name || e.toolName === name))
      .map((e) => toToolCall(e, turn)),
  );
}

function toToolCall(e: AgentTraceEntry, turn: number): ToolCall {
  let result: unknown = e.result;
  if (!e.isError && e.result) {
    try {
      result = JSON.parse(e.result);
    } catch {
      // keep the raw text
    }
  }
  return { name: e.toolName ?? "?", input: (e.input ?? {}) as Record<string, any>, ok: !e.isError, result, turn };
}

const summarise = (calls: ToolCall[]) =>
  calls.length === 0
    ? "no such call"
    : calls.map((c) => `${c.ok ? "ok" : "error"} ${JSON.stringify(c.input)} -> ${String(JSON.stringify(c.result)).slice(0, 160)}`).join(" | ");

/** Any check as a fact. */
export function fact(description: string, check: (w: EvalWorld) => boolean | string): Fact {
  return {
    fact: description,
    check: (w) => {
      const outcome = check(w);
      return outcome === true ? true : outcome === false ? "it did not" : outcome;
    },
  };
}

/** The Agent called `tool` (optionally: successfully, and/or matching `where`). */
export function called(
  tool: string,
  options: { ok?: boolean; where?: (c: ToolCall, w: EvalWorld) => boolean; description?: string } = {},
): Fact {
  const description =
    options.description ?? `${tool} was ${options.ok === true ? "called successfully" : options.ok === false ? "refused" : "called"}`;
  return fact(description, (w) => {
    const calls = toolCalls(w, tool);
    const hit = calls.some(
      (c) => (options.ok === undefined || c.ok === options.ok) && (!options.where || options.where(c, w)),
    );
    return hit || summarise(calls);
  });
}

/** The Agent never called `tool`. */
export function notCalled(tool: string): Fact {
  return fact(`${tool} was never called`, (w) => {
    const calls = toolCalls(w, tool);
    return calls.length === 0 || summarise(calls);
  });
}

/** Every call to `tool` (if any) was refused by the server. */
export function neverSucceeded(tool: string): Fact {
  return fact(`${tool} never succeeded`, (w) => {
    const ok = toolCalls(w, tool).filter((c) => c.ok);
    return ok.length === 0 || summarise(ok);
  });
}

/** Jobs that exist now but not in the seed. */
export function createdJobs(w: EvalWorld): DashboardJob[] {
  const seeded = new Set(w.initialState.jobs.map((j) => j.jobReference));
  return w.state.jobs.filter((j) => !seeded.has(j.jobReference));
}

export function newJobs(holds: (jobs: DashboardJob[], w: EvalWorld) => boolean, description: string): Fact {
  return fact(description, (w) => {
    const jobs = createdJobs(w);
    return (
      holds(jobs, w) ||
      `new Jobs: ${jobs.length ? jobs.map((j) => `${j.jobReference} ${j.issueType} for ${j.customer.fullName} ${JSON.stringify(j.visits.map((v) => `${v.date} ${v.timeWindow}${v.isEmergencyVisit ? " (emergency)" : ""}`))}`).join("; ") : "none"}`
    );
  });
}

export const noNewJobs = (): Fact => newJobs((jobs) => jobs.length === 0, "no Job was booked");

export function conversationTickets(w: EvalWorld): DashboardHandoffTicket[] {
  return w.state.handoffTickets.filter((t) => t.conversationId === w.conversationId);
}

export function ticketsInConversation(
  holds: (tickets: DashboardHandoffTicket[], w: EvalWorld) => boolean,
  description: string,
): Fact {
  return fact(description, (w) => {
    const tickets = conversationTickets(w);
    return (
      holds(tickets, w) ||
      `tickets: ${tickets.length ? tickets.map((t) => `${t.ticketReference} ${t.escalationReason}/${t.urgency}/${t.status} (${t.timeline.length} timeline)`).join("; ") : "none"}`
    );
  });
}

/** Exactly one Handoff Ticket with this reason was raised from the conversation. */
export function oneTicket(reason: DashboardHandoffTicket["escalationReason"], urgency?: DashboardHandoffTicket["urgency"]): Fact {
  return ticketsInConversation(
    (tickets) => {
      const matching = tickets.filter((t) => t.escalationReason === reason);
      return matching.length === 1 && (!urgency || matching[0]!.urgency === urgency);
    },
    `exactly one ${reason} Handoff Ticket${urgency ? ` (${urgency})` : ""} was raised`,
  );
}

export function noTicket(reason?: DashboardHandoffTicket["escalationReason"]): Fact {
  return ticketsInConversation(
    (tickets) => !tickets.some((t) => !reason || t.escalationReason === reason),
    reason ? `no ${reason} Handoff Ticket was raised` : "no Handoff Ticket was raised",
  );
}

/** The Emergency pre-filter fired for this kind (or, with "none", never fired). */
export function prefilter(kind: EmergencyKind | "none"): Fact {
  const description = kind === "none" ? "the Emergency pre-filter did not fire" : `the Emergency pre-filter showed the ${kind} Safety Script`;
  return fact(description, (w) => {
    const hits = w.trace.filter((e) => e.kind === "emergency_prefilter");
    const kinds = hits.map((e) => (e.input as { emergencyKind?: string } | null)?.emergencyKind);
    if (kind === "none") return hits.length === 0 || `fired: ${kinds.join(", ")}`;
    return kinds.includes(kind) || `fired: ${kinds.join(", ") || "never"}`;
  });
}

export function replied(kind: ChatMessageKind): Fact {
  return fact(`the Agent showed a ${kind} reply`, (w) => {
    const kinds = w.replies.map((r) => r.kind);
    return kinds.includes(kind) || `reply kinds: ${kinds.join(", ")}`;
  });
}

/** verify_customer returned verified: true (optionally for a matching call). */
export const verifiedSuccessfully = (where?: (c: ToolCall) => boolean, description = "verify_customer succeeded"): Fact =>
  called("verify_customer", { where: (c) => c.ok && c.result?.verified === true && (!where || where(c)), description });
