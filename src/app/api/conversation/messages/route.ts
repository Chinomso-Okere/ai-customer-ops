import { NextResponse, type NextRequest } from "next/server";
import {
  ConversationNotFoundError,
  DemoSessionNotFoundError,
  EmptyCustomerMessageError,
} from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { readConversationId, readDemoSessionId } from "../../demo-session-cookie";

export const dynamic = "force-dynamic";
/** A turn may take several model calls. */
export const maxDuration = 60;

/** Sends the Customer's message to the Agent; returns the Agent's replies and the transcript. */
export async function POST(request: NextRequest) {
  const sessionId = readDemoSessionId(request);
  const conversationId = readConversationId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  if (!conversationId) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const service = await getDemoSessionService();
  try {
    const result = await service.sendCustomerMessage(sessionId, conversationId, text);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DemoSessionNotFoundError) {
      return NextResponse.json({ error: "demo_session_not_found" }, { status: 404 });
    }
    if (error instanceof ConversationNotFoundError) {
      return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    }
    if (error instanceof EmptyCustomerMessageError) {
      return NextResponse.json({ error: "empty_message" }, { status: 400 });
    }
    throw error;
  }
}
