import { londonDateOf } from "@/domain/london-time";
import { fittingVisitOffer } from "@/server/scheduling/fitting-visit";
import { getVerification, normaliseJobReference, verifiedJobId } from "@/server/verification";
import { TOOL_ERRORS, type AgentTool } from "../types";

/** Read-only Job lookup (#6); refuses unless the conversation is verified for the Job's Customer. */
export const getJobDetails: AgentTool = {
  name: "get_job_details",
  description:
    "Looks up a Job's status, Issue Type and postcode (use them for get_availability), upcoming Visits (visitId, date and Time Window; use visitId to reschedule or cancel), assigned Engineer's first name and any Parts Orders with their Parts Status. Only works after verify_customer has succeeded in this conversation, and only for that Customer's Jobs.",
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
      if (state.locked) {
        return {
          ok: false,
          error: "Verification is locked for this conversation; no Job details can be shared. Offer Escalation instead.",
        };
      }
      if (!state.verifiedCustomerId) return TOOL_ERRORS.notVerified;
      return {
        ok: false,
        error: `${normaliseJobReference(reference)} is not one of the verified Customer's Jobs. Ask which of their Jobs they mean.`,
      };
    }

    const { db, sessionId } = ctx;
    const today = londonDateOf(ctx.now);
    const job = await db.query<{
      job_reference: string;
      issue_type: string;
      description: string;
      job_status: string;
      postcode: string;
    }>(
      `SELECT j.job_reference, j.issue_type, j.description, j.job_status, c.postcode
         FROM job j
         JOIN customer c ON c.id = j.customer_id AND c.session_id = j.session_id
        WHERE j.session_id = $1 AND j.id = $2`,
      [sessionId, jobId],
    );
    const visits = await db.query<{ id: string; date: string; time_window: string; engineer_name: string; upcoming: boolean }>(
      `SELECT v.id, v.visit_date::text AS date, v.time_window, e.name AS engineer_name, v.visit_date >= $3::date AS upcoming
         FROM visit v
         JOIN engineer e ON e.id = v.engineer_id AND e.session_id = v.session_id
        WHERE v.session_id = $1 AND v.job_id = $2 AND v.cancelled_at IS NULL
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
        postcode: j.postcode,
        description: j.description,
        jobStatus: j.job_status,
        upcomingVisits: upcoming.map((v) => ({
          visitId: v.id,
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
