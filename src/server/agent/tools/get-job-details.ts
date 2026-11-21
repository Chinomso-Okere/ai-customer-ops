import { londonDateOf } from "@/domain/london-time";
import { fittingVisitOffer } from "@/server/scheduling/fitting-visit";
import { getVerification, normaliseJobReference, verifiedJobId } from "@/server/verification";
import type { AgentTool } from "../types";

/** Read-only Job lookup (#6); refuses unless the conversation is verified for the Job's Customer. */
export const getJobDetails: AgentTool = {
  name: "get_job_details",
  description:
    "Looks up a Job's status, upcoming Visits (date and Time Window), assigned Engineer's first name and any Parts Orders with their Parts Status. Only works after verify_customer has succeeded in this conversation, and only for that Customer's Jobs.",
  inputSchema: {
    type: "object",
    properties: {
      jobReference: { type: "string", description: "Job Reference, e.g. APX-10482" },
    },
    required: ["jobReference"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const reference = typeof input.jobReference === "string" ? input.jobReference : "";
    if (reference.trim() === "") return { ok: false, error: "No Job Reference given." };

    const jobId = await verifiedJobId(ctx.db, ctx, reference);
    if (!jobId) {
      const state = await getVerification(ctx.db, ctx);
      return {
        ok: false,
        error: state.locked
          ? "Verification is locked for this conversation; no Job details can be shared. Offer Escalation instead."
          : state.verifiedCustomerId
            ? `${normaliseJobReference(reference)} is not one of the verified Customer's Jobs. Ask which of their Jobs they mean.`
            : "The Customer is not verified in this conversation. Call verify_customer first.",
      };
    }

    const { db, sessionId } = ctx;
    const today = londonDateOf(ctx.now);
    const job = await db.query<{ job_reference: string; issue_type: string; description: string; job_status: string }>(
      `SELECT job_reference, issue_type, description, job_status FROM job WHERE session_id = $1 AND id = $2`,
      [sessionId, jobId],
    );
    const visits = await db.query<{ date: string; time_window: string; engineer_name: string; upcoming: boolean }>(
      `SELECT v.visit_date::text AS date, v.time_window, e.name AS engineer_name, v.visit_date >= $3::date AS upcoming
         FROM visit v
         JOIN engineer e ON e.id = v.engineer_id AND e.session_id = v.session_id
        WHERE v.session_id = $1 AND v.job_id = $2
        ORDER BY v.visit_date, v.time_window`,
      [sessionId, jobId, today],
    );
    const parts = await db.query<{ partName: string; partsStatus: string; expectedArrival: string }>(
      `SELECT part_name AS "partName", parts_status AS "partsStatus", expected_arrival::text AS "expectedArrival"
         FROM parts_order
        WHERE session_id = $1 AND job_id = $2
        ORDER BY created_at, id`,
      [sessionId, jobId],
    );

    const firstName = (name: string) => name.split(" ")[0]!;
    const upcoming = visits.rows.filter((v) => v.upcoming);
    // The assigned Engineer: whoever attends next, else whoever attended last.
    const assigned = upcoming[0] ?? visits.rows.at(-1);
    const j = job.rows[0]!;
    return {
      ok: true,
      result: {
        jobReference: j.job_reference,
        issueType: j.issue_type,
        description: j.description,
        jobStatus: j.job_status,
        upcomingVisits: upcoming.map((v) => ({
          date: v.date,
          timeWindow: v.time_window,
          engineerFirstName: firstName(v.engineer_name),
        })),
        assignedEngineerFirstName: assigned ? firstName(assigned.engineer_name) : null,
        partsOrders: parts.rows,
        fittingVisitOffer: await fittingVisitOffer(db, sessionId, jobId, ctx.now),
      },
    };
  },
};
