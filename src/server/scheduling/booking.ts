import type { IssueType } from "@/domain/vocabulary";
import { matchCustomer } from "./customer-matching";
import type { Database } from "@/server/db/database";
import { lockDemoSession } from "@/server/db/session-lock";
import { checkWindowAvailable, type CandidateWindow } from "./availability";

export interface CreatedVisit {
  visitId: string;
  engineerId: string;
  engineerName: string;
}

/**
 * Adds a Visit to a Job in `window`, assigned to the first free Engineer skilled
 * for `issueType`. Returns undefined (writing nothing) if the window isn't
 * bookable now or nobody skilled is free. Call inside a transaction.
 */
export async function createVisit(
  tx: Database,
  sessionId: string,
  visit: { jobId: string; issueType: IssueType; window: CandidateWindow; now: Date },
): Promise<CreatedVisit | undefined> {
  // Two conversations can't both take the last free Engineer.
  await lockDemoSession(tx, sessionId);
  const available = await checkWindowAvailable(tx, sessionId, visit.issueType, visit.window, visit.now);
  const engineerId = available?.freeEngineerIds[0];
  if (!engineerId) return undefined;
  const { rows } = await tx.query<{ id: string; engineer_name: string }>(
    `INSERT INTO visit (session_id, job_id, engineer_id, visit_date, time_window)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, (SELECT name FROM engineer WHERE id = $3 AND session_id = $1) AS engineer_name`,
    [sessionId, visit.jobId, engineerId, visit.window.date, visit.window.timeWindow],
  );
  return { visitId: rows[0]!.id, engineerId, engineerName: rows[0]!.engineer_name };
}

/** The next Job Reference in this Demo Session (highest so far + 1). */
export async function nextJobReference(tx: Database, sessionId: string): Promise<string> {
  const { rows } = await tx.query<{ max: number | null }>(
    "SELECT max(substring(job_reference FROM 5)::int) AS max FROM job WHERE session_id = $1",
    [sessionId],
  );
  return `APX-${(rows[0]?.max ?? 10400) + 1}`;
}

export interface NewCustomer {
  fullName: string;
  /** Display form, e.g. "SW4 9ZZ". */
  postcode: string;
  email: string;
  phone: string | null;
}

export interface BookedJob {
  jobId: string;
  jobReference: string;
  customerId: string;
  visit: CreatedVisit;
}

/**
 * Books: a Scheduled Job and its first Visit, under the matching Customer or a
 * new one (see `matchCustomer`). Returns
 * undefined (writing nothing that survives the caller's rollback) if the window
 * has no Availability. Call inside a transaction; roll back on undefined.
 */
export async function bookJob(
  tx: Database,
  sessionId: string,
  booking: {
    customer: NewCustomer;
    issueType: IssueType;
    description: string;
    window: CandidateWindow;
    now: Date;
  },
): Promise<BookedJob | undefined> {
  // Two conversations can't both take the last free Engineer.
  await lockDemoSession(tx, sessionId);
  const available = await checkWindowAvailable(tx, sessionId, booking.issueType, booking.window, booking.now);
  if (!available) return undefined;

  const { customerId, jobId, jobReference } = await createCustomerJob(tx, sessionId, booking);
  const visit = await createVisit(tx, sessionId, {
    jobId,
    issueType: booking.issueType,
    window: booking.window,
    now: booking.now,
  });
  if (!visit) throw new Error("bookJob: Availability vanished inside the schedule lock");
  return { jobId, jobReference, customerId, visit };
}

/**
 * Creates a Scheduled Job (no Visit yet) under the matching Customer or a new
 * one (see `matchCustomer`). Call inside a transaction.
 */
export async function createCustomerJob(
  tx: Database,
  sessionId: string,
  booking: { customer: NewCustomer; issueType: IssueType; description: string; now: Date },
): Promise<{ customerId: string; jobId: string; jobReference: string }> {
  const { customer } = booking;
  const match = await matchCustomer(tx, sessionId, customer);
  const customerId =
    match.kind === "existing"
      ? match.customerId
      : (
          await tx.query<{ id: string }>(
            `INSERT INTO customer (session_id, full_name, postcode, email, phone, created_at, possible_duplicate_of)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              sessionId,
              customer.fullName,
              customer.postcode,
              customer.email,
              customer.phone,
              booking.now,
              match.kind === "possibleDuplicate" ? match.ofCustomerId : null,
            ],
          )
        ).rows[0]!.id;
  const jobReference = await nextJobReference(tx, sessionId);
  const jobRow = await tx.query<{ id: string }>(
    `INSERT INTO job (session_id, job_reference, customer_id, issue_type, description, job_status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'Scheduled', $6) RETURNING id`,
    [sessionId, jobReference, customerId, booking.issueType, booking.description, booking.now],
  );
  const jobId = jobRow.rows[0]!.id;
  return { customerId, jobId, jobReference };
}
