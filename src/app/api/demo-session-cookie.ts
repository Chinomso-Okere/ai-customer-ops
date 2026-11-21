import type { NextRequest, NextResponse } from "next/server";
import { DEMO_SESSION_TTL_MS } from "@/server/demo-session";

/** The visitor's Demo Session id lives in this cookie. */
export const DEMO_SESSION_COOKIE = "apex_demo_session";

export function readDemoSessionId(request: NextRequest): string | undefined {
  return request.cookies.get(DEMO_SESSION_COOKIE)?.value;
}

export function writeDemoSessionId(response: NextResponse, sessionId: string): NextResponse {
  response.cookies.set(DEMO_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(DEMO_SESSION_TTL_MS / 1000),
  });
  return response;
}
