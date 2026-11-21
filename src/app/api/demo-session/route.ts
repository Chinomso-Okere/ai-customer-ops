import { NextResponse, type NextRequest } from "next/server";
import { DemoSessionRateLimitedError } from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { RATE_LIMITED_BODY, readClientIp, readDemoSessionId, writeDemoSessionId } from "../demo-session-cookie";

/** Opens the visitor's Demo Session: resumes the one in their cookie, or starts a new one. */
export async function POST(request: NextRequest) {
  const service = await getDemoSessionService();
  try {
    const sessionId = await service.openDemoSession(readDemoSessionId(request), {
      clientIp: readClientIp(request),
    });
    return writeDemoSessionId(NextResponse.json({ sessionId }), sessionId);
  } catch (error) {
    if (error instanceof DemoSessionRateLimitedError) return NextResponse.json(RATE_LIMITED_BODY, { status: 429 });
    throw error;
  }
}
