import { NextResponse, type NextRequest } from "next/server";
import { DemoSessionNotFoundError } from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { readDemoSessionId } from "../demo-session-cookie";

export const dynamic = "force-dynamic";

/** The Operations Dashboard state for the visitor's Demo Session; polled by the page. */
export async function GET(request: NextRequest) {
  const sessionId = readDemoSessionId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  const service = await getDemoSessionService();
  try {
    const state = await service.getDashboardState(sessionId);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DemoSessionNotFoundError) {
      return NextResponse.json({ error: "demo_session_not_found" }, { status: 404 });
    }
    throw error;
  }
}
