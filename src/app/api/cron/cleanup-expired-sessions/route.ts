import { NextResponse, type NextRequest } from "next/server";
import { getDemoSessionService } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Deletes expired Demo Sessions and all their data. Called by Vercel Cron
 * (`vercel.json`), which sends `Authorization: Bearer $CRON_SECRET`. Refuses
 * every request when CRON_SECRET is unset, so it is never public.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const service = await getDemoSessionService();
  const deleted = await service.deleteExpiredDemoSessions();
  return NextResponse.json({ deleted: deleted.length }, { headers: { "Cache-Control": "no-store" } });
}
