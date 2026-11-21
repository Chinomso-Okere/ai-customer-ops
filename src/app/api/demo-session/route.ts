import { NextResponse, type NextRequest } from "next/server";
import { getDemoSessionService } from "@/server/runtime";
import { readDemoSessionId, writeDemoSessionId } from "../demo-session-cookie";

/** Opens the visitor's Demo Session: resumes the one in their cookie, or starts a new one. */
export async function POST(request: NextRequest) {
  const service = await getDemoSessionService();
  const sessionId = await service.openDemoSession(readDemoSessionId(request));
  return writeDemoSessionId(NextResponse.json({ sessionId }), sessionId);
}
