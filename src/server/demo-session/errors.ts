/** The Demo Session does not exist or has expired; the visitor should start a new one. */
export class DemoSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Demo Session not found or expired: ${sessionId}`);
    this.name = "DemoSessionNotFoundError";
  }
}

/** The conversation does not exist in this Demo Session; the widget should open a new one. */
export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found in this Demo Session: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

/** The Customer message was empty (or only whitespace). */
export class EmptyCustomerMessageError extends Error {
  constructor() {
    super("Customer message is empty");
    this.name = "EmptyCustomerMessageError";
  }
}

/** No Handoff Ticket with this id in this Demo Session. */
export class HandoffTicketNotFoundError extends Error {
  constructor(ticketId: string) {
    super(`Handoff Ticket not found in this Demo Session: ${ticketId}`);
    this.name = "HandoffTicketNotFoundError";
  }
}

/** The Handoff Ticket's status does not allow this change (e.g. acknowledging a Resolved ticket). */
export class HandoffTicketStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffTicketStateError";
  }
}

/** Too many new Demo Sessions from this visitor's IP in the last hour; they should try again later. */
export class DemoSessionRateLimitedError extends Error {
  constructor() {
    super("Too many new Demo Sessions from this IP; try again later");
    this.name = "DemoSessionRateLimitedError";
  }
}
