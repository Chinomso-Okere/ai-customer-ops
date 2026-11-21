/**
 * The Customer's chat with the Agent. Non-functional placeholder until the
 * Agent chat ticket (#3) wires it to the Demo Session service.
 */
export function ChatWidget() {
  return (
    <div className="chat" aria-label="Chat with Apex">
      <div className="chat__header">Chat with Apex</div>
      <div className="chat__messages">
        <p className="muted">The Agent is coming soon.</p>
      </div>
      <form className="chat__composer" onSubmit={(e) => e.preventDefault()}>
        <input className="chat__input" placeholder="Type a message…" disabled aria-label="Message" />
        <button className="button" type="submit" disabled>
          Send
        </button>
      </form>
    </div>
  );
}
