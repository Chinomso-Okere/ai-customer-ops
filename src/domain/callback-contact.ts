/**
 * A callback needs both a name and a phone number. True while either is
 * missing from a Handoff Ticket, so the Agent (and the Dashboard) still have
 * something to ask for.
 */
export function contactStillNeeded(ticket: { contactName: string | null; contactPhone: string | null }): boolean {
  return !(ticket.contactName && ticket.contactPhone);
}
