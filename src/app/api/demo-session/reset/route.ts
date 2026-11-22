import { NextResponse, type NextRequest } from "next/server";
import { DemoSessionRateLimitedError } from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { RATE_LIMITED_BODY, readClientIp, readDemoSessionId, writeDemoSessionId } from "../../demo-session-cookie";

/** "Reset demo" / "Start a new demo": replaces the Demo Session in the visitor's cookie with a new one. */
export async function POST(request: NextRequest) {
  const service = await getDemoSessionService();
  try {
    const sessionId = await service.resetDemoSession(readDemoSessionId(request), {
      clientIp: readClientIp(request),
    });
    return writeDemoSessionId(NextResponse.json({ sessionId }), sessionId);
  } catch (error) {
    if (error instanceof DemoSessionRateLimitedError) return NextResponse.json(RATE_LIMITED_BODY, { status: 429 });
    throw error;
  }
}
