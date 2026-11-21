import { NextResponse, type NextRequest } from "next/server";
import { JOB_STATUSES, PARTS_STATUSES, type JobStatus, type PartsStatus } from "@/domain/vocabulary";
import { DemoSessionNotFoundError, InvalidStatusAdvanceError } from "@/server/demo-session";
import { getDemoSessionService } from "@/server/runtime";
import { readDemoSessionId } from "../../demo-session-cookie";

export const dynamic = "force-dynamic";

/**
 * Presenter control: advances a Job or Parts Order one status step.
 * Body: `{ target: "job" | "parts_order", id, from }`, where `from` is the status the Operator saw.
 */
export async function POST(request: NextRequest) {
  const sessionId = readDemoSessionId(request);
  if (!sessionId) return NextResponse.json({ error: "no_demo_session" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { target?: unknown; id?: unknown; from?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const from = body?.from;
  const service = await getDemoSessionService();
  try {
    if (body?.target === "job" && JOB_STATUSES.includes(from as JobStatus)) {
      return NextResponse.json(await service.advanceJobStatus(sessionId, id, from as JobStatus));
    }
    if (body?.target === "parts_order" && PARTS_STATUSES.includes(from as PartsStatus)) {
      return NextResponse.json(await service.advancePartsStatus(sessionId, id, from as PartsStatus));
    }
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  } catch (error) {
    if (error instanceof DemoSessionNotFoundError) {
      return NextResponse.json({ error: "demo_session_not_found" }, { status: 404 });
    }
    if (error instanceof InvalidStatusAdvanceError) {
      return NextResponse.json({ error: "invalid_status_advance", message: error.message }, { status: 409 });
    }
    throw error;
  }
}
