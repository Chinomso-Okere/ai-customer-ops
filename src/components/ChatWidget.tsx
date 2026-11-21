"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage, CustomerTurnResult } from "@/server/demo-session";

async function openConversation(): Promise<ChatMessage[]> {
  const response = await fetch("/api/conversation", { method: "POST" });
  if (!response.ok) throw new Error(`Chat unavailable (${response.status})`);
  return ((await response.json()) as { messages: ChatMessage[] }).messages;
}

async function postMessage(text: string): Promise<Response> {
  return fetch("/api/conversation/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** A message sent from outside the composer (e.g. the scenario tray); a new `id` sends it. */
export interface OutgoingChatMessage {
  id: number;
  text: string;
}

/**
 * The Customer's chat with the Agent. A thin client over the Demo Session
 * service; it (re)opens the conversation whenever the Demo Session changes.
 */
export function ChatWidget({
  sessionId,
  outgoing,
  onStartNewDemo,
  startingNewDemo,
  notice,
}: {
  sessionId: string | null;
  outgoing?: OutgoingChatMessage | null;
  /** Starts a fresh Demo Session (offered once the message cap is reached). */
  onStartNewDemo: () => void;
  startingNewDemo: boolean;
  /** Why a new Demo Session couldn't start (e.g. "try again later"). */
  notice: string | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The Demo Session's message cap was reached: the Agent won't answer any more. */
  const capped = messages.at(-1)?.kind === "message_cap";

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setMessages([]);
    openConversation()
      .then((m) => {
        if (cancelled) return;
        setMessages(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, pending]);

  const sendText = async (raw: string) => {
    const text = raw.trim();
    if (!text || pending || !sessionId) return;
    setDraft("");
    setPending(text);
    setError(null);
    try {
      let response = await postMessage(text);
      if (response.status === 404) {
        // Conversation gone (e.g. after a reset): open a fresh one and resend once.
        await openConversation();
        response = await postMessage(text);
      }
      if (!response.ok) throw new Error(`Message not sent (${response.status})`);
      setMessages(((await response.json()) as CustomerTurnResult).conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDraft(text);
    } finally {
      setPending(null);
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    void sendText(draft);
  };

  // Send each outgoing message once, as soon as the chat is free.
  const lastOutgoingId = useRef<number | null>(null);
  useEffect(() => {
    if (!outgoing || outgoing.id === lastOutgoingId.current || !sessionId || pending) return;
    lastOutgoingId.current = outgoing.id;
    void sendText(outgoing.text);
  }, [outgoing, sessionId, pending]); // sendText is recreated each render; deliberately not a dep

  return (
    <div className="chat" aria-label="Chat with Apex">
      <div className="chat__header">Chat with Apex</div>
      <div className="chat__messages" ref={scroller} aria-live="polite">
        {messages.length === 0 && !pending && (
          <p className="muted">Ask about prices, check we cover your postcode, or tell us what's wrong.</p>
        )}
        {messages.map((m) => (
          <p key={m.id} className={`bubble bubble--${m.speaker === "Customer" ? "customer" : "agent"} bubble--${m.kind}`}>
            {m.text}
          </p>
        ))}
        {capped && (
          <button className="button chat__start-new-demo" onClick={onStartNewDemo} disabled={startingNewDemo}>
            {startingNewDemo ? "Starting a new demo…" : "Start a new demo"}
          </button>
        )}
        {capped && notice && (
          <p className="banner banner--notice" role="status">
            {notice}
          </p>
        )}
        {pending && (
          <>
            <p className="bubble bubble--customer">{pending}</p>
            <p className="bubble bubble--agent bubble--typing muted">Apex is typing…</p>
          </>
        )}
        {error && <p className="banner banner--error">{error}</p>}
      </div>
      <form className="chat__composer" onSubmit={send}>
        <input
          className="chat__input"
          placeholder="Type a message…"
          aria-label="Message"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!sessionId || capped}
        />
        <button className="button" type="submit" disabled={!sessionId || capped || !!pending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
