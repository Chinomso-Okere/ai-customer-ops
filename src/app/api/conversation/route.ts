import { NextResponse, type NextRequest } from "next/server";
import { DemoSessionNotFoundError } from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { readConversationId, readDemoSessionId, writeConversationId } from "../demo-session-cookie";

export const dynamic = "force-dynamic";

/**
 * Opens the visitor's chat: resumes the conversation in their cookie if it
 * belongs to their Demo Session, otherwise starts a new one. Returns the transcript.
 */
export async function POST(request: NextRequest) {
  const sessionId = readDemoSessionId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  const service = await getDemoSessionService();
  try {
    const conversationId = await service.openConversation(sessionId, readConversationId(request));
    const messages = await service.getConversation(sessionId, conversationId);
    return writeConversationId(NextResponse.json({ conversationId, messages }), conversationId);
  } catch (error) {
    if (error instanceof DemoSessionNotFoundError) {
      return NextResponse.json({ error: "demo_session_not_found" }, { status: 404 });
    }
    throw error;
  }
}
