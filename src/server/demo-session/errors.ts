/** The Demo Session does not exist or has expired; the visitor should start a new one. */
export class DemoSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Demo Session not found or expired: ${sessionId}`);
    this.name = "DemoSessionNotFoundError";
  }
}
