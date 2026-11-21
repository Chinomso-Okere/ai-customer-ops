import { NextResponse, type NextRequest } from "next/server";
import {
  DemoSessionNotFoundError,
  HandoffTicketNotFoundError,
  HandoffTicketStateError,
} from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { readDemoSessionId } from "../../demo-session-cookie";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ ticketId: string }>;
}

/** The ticket's full conversation transcript, for the Operator's detail view. */
export async function GET(request: NextRequest, { params }: Params) {
  const sessionId = readDemoSessionId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  const { ticketId } = await params;
  const service = await getDemoSessionService();
  try {
    const transcript = await service.getHandoffTicketTranscript(sessionId, ticketId);
    return NextResponse.json({ transcript }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** An Operator action: body `{ action: "acknowledge" | "resolve" }`. */
export async function POST(request: NextRequest, { params }: Params) {
  const sessionId = readDemoSessionId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  const { ticketId } = await params;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const service = await getDemoSessionService();
  try {
    if (body?.action === "acknowledge") await service.acknowledgeHandoffTicket(sessionId, ticketId);
    else if (body?.action === "resolve") await service.resolveHandoffTicket(sessionId, ticketId);
    else return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof DemoSessionNotFoundError) {
    return NextResponse.json({ error: "demo_session_not_found" }, { status: 404 });
  }
  if (error instanceof HandoffTicketNotFoundError) {
    return NextResponse.json({ error: "handoff_ticket_not_found" }, { status: 404 });
  }
  if (error instanceof HandoffTicketStateError) {
    return NextResponse.json({ error: "invalid_ticket_status", message: error.message }, { status: 409 });
  }
  throw error;
}
