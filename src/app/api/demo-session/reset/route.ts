import { NextResponse } from "next/server";
import { getDemoSessionService } from "@/server/runtime";
import { writeDemoSessionId } from "../../demo-session-cookie";

/** "Reset demo": always starts a brand-new Demo Session. */
export async function POST() {
  const service = await getDemoSessionService();
  const sessionId = await service.createDemoSession();
  return writeDemoSessionId(NextResponse.json({ sessionId }), sessionId);
}
