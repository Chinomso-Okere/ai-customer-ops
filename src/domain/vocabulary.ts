/** Domain vocabulary from GLOSSARY.md, as types and ordered value lists. */

export const ISSUE_TYPES = [
  "Boiler Repair",
  "Boiler Service",
  "Radiators & Heating",
  "AC Repair & Install",
  "Heat Pump",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Forward order of the Job Status lifecycle; Cancelled is terminal and off the path. */
export const JOB_STATUSES = [
  "Scheduled",
  "In Progress",
  "Awaiting Parts",
  "Completed",
  "Cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PARTS_STATUSES = ["Ordered", "Dispatched", "Arrived", "Fitted"] as const;
export type PartsStatus = (typeof PARTS_STATUSES)[number];

export const ESCALATION_REASONS = ["Emergency", "Complaint", "Out of Policy"] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** Most urgent first; this order is the Handoff Ticket queue's primary sort. */
export const URGENCIES = ["Critical", "High", "Normal"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const HANDOFF_TICKET_STATUSES = ["Open", "Acknowledged", "Resolved"] as const;
export type HandoffTicketStatus = (typeof HANDOFF_TICKET_STATUSES)[number];

/**
 * The Issue Type named by `input`, compared case- and whitespace-insensitively
 * (strict tool schemas don't guarantee enum casing); undefined if none matches.
 */
export function parseIssueType(input: unknown): IssueType | undefined {
  if (typeof input !== "string") return undefined;
  const key = input.replace(/\s+/g, " ").trim().toLowerCase();
  return ISSUE_TYPES.find((t) => t.toLowerCase() === key);
}
