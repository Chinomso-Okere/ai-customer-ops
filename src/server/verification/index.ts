/**
 * Verification (#6): proving a Customer's identity in one conversation before
 * the Agent reveals Job details.
 *
 * - Path A: Job Reference + (postcode or email)
 * - Path B: full name + postcode + email
 *
 * Matching ignores case and whitespace; postcodes are compared with spaces
 * removed. No fuzzy name matching. 3 failed attempts lock Verification for the
 * conversation; once verified, the Customer stays verified for it.
 *
 * One chat is about one Customer (#27): the first successful Verification or
 * Booking in a conversation sets its Customer, and from then on only that
 * Customer can be verified. Details for anyone else are refused exactly like
 * garbage details (the `otherCustomer` outcome), so the refusal never reveals
 * whether another Customer matches.
 *
 * Other tools that reveal or change a Customer's data (reschedule, cancel,
 * parts fitting) must gate on `isVerifiedForJob` / `getVerification`.
 */
import { normalisePostcode } from "@/domain/coverage-area";
import type { JobStatus } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";

export const MAX_VERIFICATION_ATTEMPTS = 3;

export interface ConversationRef {
  sessionId: string;
  conversationId: string;
}

export interface VerificationState {
  /** The Customer this conversation is verified for, or null. */
  verifiedCustomerId: string | null;
  failedAttempts: number;
  attemptsRemaining: number;
  locked: boolean;
}

export interface VerificationDetails {
  jobReference?: string;
  postcode?: string;
  email?: string;
  fullName?: string;
}

export interface VerifiedJobSummary {
  jobReference: string;
  description: string;
  jobStatus: JobStatus;
}

export type VerificationOutcome =
  | {
      kind: "verified";
      customerId: string;
      fullName: string;
      jobs: VerifiedJobSummary[];
      /** Path A names the Job; Path B leaves it to the Customer when they have several. */
      jobReference: string | null;
      alreadyVerified: boolean;
    }
  | { kind: "failed"; attemptsRemaining: number; locked: boolean }
  /**
   * The conversation already has a Customer and these details did not match
   * them (valid for someone else, or just wrong: callers cannot tell which).
   * An attempt is used, as for `failed`.
   */
  | { kind: "otherCustomer"; attemptsRemaining: number; locked: boolean }
  | { kind: "locked" }
  /** Neither path's details are complete; no attempt is used. */
  | { kind: "incomplete"; missing: string };

/** "Sarah  MITCHELL " → "sarah mitchell". */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normaliseEmail(email: string): string {
  return email.replace(/\s+/g, "").toLowerCase();
}

/**
 * SQL that is true when `column` holds the email in `param` (already passed
 * through `normaliseEmail`): the same normalisation, in Postgres. Every email
 * lookup (Verification, Customer matching) uses it so they agree.
 */
export function sqlEmailEquals(column: string, param: string): string {
  return `lower(regexp_replace(${column}, '\\s', '', 'g')) = ${param}`;
}

/** "apx 10482" / "10482" → "APX-10482". */
export function normaliseJobReference(reference: string): string {
  const compact = reference.replace(/\s+/g, "").toUpperCase();
  const digits = /^(?:APX-?)?(\d+)$/.exec(compact);
  return digits ? `APX-${digits[1]}` : compact;
}

export async function getVerification(db: Database, ref: ConversationRef): Promise<VerificationState> {
  const { rows } = await db.query<{ verified_customer_id: string | null; failed_attempts: number }>(
    `SELECT verified_customer_id, failed_attempts
       FROM conversation_verification
      WHERE session_id = $1 AND conversation_id = $2`,
    [ref.sessionId, ref.conversationId],
  );
  const verifiedCustomerId = rows[0]?.verified_customer_id ?? null;
  const failedAttempts = rows[0]?.failed_attempts ?? 0;
  return {
    verifiedCustomerId,
    failedAttempts,
    attemptsRemaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - failedAttempts),
    locked: verifiedCustomerId === null && failedAttempts >= MAX_VERIFICATION_ATTEMPTS,
  };
}

/**
 * The Job's id if this conversation is verified for the Customer who owns it,
 * else null. `jobReference` may be in any case/spacing.
 */
export async function verifiedJobId(
  db: Database,
  ref: ConversationRef,
  jobReference: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT j.id
       FROM conversation_verification v
       JOIN job j ON j.session_id = v.session_id AND j.customer_id = v.verified_customer_id
      WHERE v.session_id = $1 AND v.conversation_id = $2 AND j.job_reference = $3`,
    [ref.sessionId, ref.conversationId, normaliseJobReference(jobReference)],
  );
  return rows[0]?.id ?? null;
}

/** Is this conversation verified for the Customer who owns `jobReference`? */
export async function isVerifiedForJob(db: Database, ref: ConversationRef, jobReference: string): Promise<boolean> {
  return (await verifiedJobId(db, ref, jobReference)) !== null;
}

/** Is this conversation verified for `customerId`? */
export async function isVerifiedForCustomer(db: Database, ref: ConversationRef, customerId: string): Promise<boolean> {
  return (await getVerification(db, ref)).verifiedCustomerId === customerId;
}

/** The Customer this conversation is about, or null if it has none yet. */
export async function getChatCustomerId(db: Database, ref: ConversationRef): Promise<string | null> {
  const { rows } = await db.query<{ customer_id: string | null }>(
    "SELECT customer_id FROM conversation WHERE session_id = $1 AND id = $2",
    [ref.sessionId, ref.conversationId],
  );
  return rows[0]?.customer_id ?? null;
}

/** Makes `customerId` the chat's Customer unless the conversation already has one. */
export async function setChatCustomerIfUnset(db: Database, ref: ConversationRef, customerId: string): Promise<void> {
  await db.query(
    "UPDATE conversation SET customer_id = $3 WHERE session_id = $1 AND id = $2 AND customer_id IS NULL",
    [ref.sessionId, ref.conversationId, customerId],
  );
}

/**
 * True when the conversation has a Customer and these Booking details name
 * someone else (a different full name or email, compared after normalising).
 */
export async function isOtherThanChatCustomer(
  db: Database,
  ref: ConversationRef,
  who: { fullName: string; email: string },
): Promise<boolean> {
  const { rows } = await db.query<{ full_name: string; email: string }>(
    `SELECT c.full_name, c.email
       FROM conversation v
       JOIN customer c ON c.session_id = v.session_id AND c.id = v.customer_id
      WHERE v.session_id = $1 AND v.id = $2`,
    [ref.sessionId, ref.conversationId],
  );
  const chatCustomer = rows[0];
  if (!chatCustomer) return false;
  return (
    normaliseName(chatCustomer.full_name) !== normaliseName(who.fullName) ||
    normaliseEmail(chatCustomer.email) !== normaliseEmail(who.email)
  );
}

/** Tries to verify the Customer, recording the attempt. */
export async function attemptVerification(
  db: Database,
  ref: ConversationRef,
  details: VerificationDetails,
  now: Date,
): Promise<VerificationOutcome> {
  const state = await getVerification(db, ref);
  const jobReference = present(details.jobReference);
  const postcode = present(details.postcode);
  const email = present(details.email);
  const fullName = present(details.fullName);

  if (state.locked) return { kind: "locked" };

  const usePathA = jobReference !== null && (postcode !== null || email !== null);
  const usePathB = !usePathA && fullName !== null && postcode !== null && email !== null;
  if (!usePathA && !usePathB) {
    // Nothing to check: a verified Customer just gets their summary again.
    if (state.verifiedCustomerId) return verified(db, ref.sessionId, state.verifiedCustomerId, jobReference, true);
    return { kind: "incomplete", missing: missingDetails(jobReference, postcode, email, fullName) };
  }

  // Once the chat has a Customer, only that Customer can match: the other
  // Customers are never looked up.
  const chatCustomerId = (await getChatCustomerId(db, ref)) ?? state.verifiedCustomerId;
  const match = usePathA
    ? await matchPathA(db, ref.sessionId, jobReference!, postcode, email, chatCustomerId)
    : await matchPathB(db, ref.sessionId, fullName!, postcode!, email!, chatCustomerId);

  if (match) {
    await db.query(
      `INSERT INTO conversation_verification (conversation_id, session_id, verified_customer_id, updated_at)
       VALUES ($2, $1, $3, $4)
       ON CONFLICT (conversation_id) DO UPDATE SET verified_customer_id = $3, updated_at = $4
         WHERE conversation_verification.session_id = $1`,
      [ref.sessionId, ref.conversationId, match.customerId, now],
    );
    await setChatCustomerIfUnset(db, ref, match.customerId);
    return verified(db, ref.sessionId, match.customerId, match.jobReference, state.verifiedCustomerId === match.customerId);
  }

  const { rows } = await db.query<{ failed_attempts: number }>(
    `INSERT INTO conversation_verification (conversation_id, session_id, failed_attempts, updated_at)
     VALUES ($2, $1, 1, $3)
     ON CONFLICT (conversation_id) DO UPDATE
       SET failed_attempts = conversation_verification.failed_attempts + 1, updated_at = $3
       WHERE conversation_verification.session_id = $1
     RETURNING failed_attempts`,
    [ref.sessionId, ref.conversationId, now],
  );
  const failedAttempts = rows[0]!.failed_attempts;
  const attemptsRemaining = Math.max(0, MAX_VERIFICATION_ATTEMPTS - failedAttempts);
  return {
    kind: chatCustomerId ? "otherCustomer" : "failed",
    attemptsRemaining,
    // A verified conversation never locks.
    locked: !state.verifiedCustomerId && attemptsRemaining === 0,
  };
}

function present(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function missingDetails(
  jobReference: string | null,
  postcode: string | null,
  email: string | null,
  fullName: string | null,
): string {
  if (jobReference) return "postcode or email";
  const missing = [!fullName && "full name", !postcode && "postcode", !email && "email"].filter(Boolean);
  return `${missing.join(", ")} (or a Job Reference with postcode or email)`;
}

async function matchPathA(
  db: Database,
  sessionId: string,
  jobReference: string,
  postcode: string | null,
  email: string | null,
  onlyCustomerId: string | null,
): Promise<{ customerId: string; jobReference: string } | null> {
  const { rows } = await db.query<{ customer_id: string; job_reference: string; postcode: string; email: string }>(
    `SELECT j.customer_id, j.job_reference, c.postcode, c.email
       FROM job j
       JOIN customer c ON c.id = j.customer_id AND c.session_id = j.session_id
      WHERE j.session_id = $1 AND j.job_reference = $2 AND ($3::uuid IS NULL OR j.customer_id = $3::uuid)`,
    [sessionId, normaliseJobReference(jobReference), onlyCustomerId],
  );
  const row = rows[0];
  if (!row) return null;
  // Every detail the Customer gave must match; one of postcode/email is enough.
  if (postcode && normalisePostcode(postcode) !== normalisePostcode(row.postcode)) return null;
  if (email && normaliseEmail(email) !== normaliseEmail(row.email)) return null;
  return { customerId: row.customer_id, jobReference: row.job_reference };
}

async function matchPathB(
  db: Database,
  sessionId: string,
  fullName: string,
  postcode: string,
  email: string,
  onlyCustomerId: string | null,
): Promise<{ customerId: string; jobReference: null } | null> {
  const { rows } = await db.query<{ id: string; full_name: string; postcode: string; email: string }>(
    `SELECT id, full_name, postcode, email
       FROM customer
      WHERE session_id = $1 AND ${sqlEmailEquals("email", "$2")} AND ($3::uuid IS NULL OR id = $3::uuid)
      ORDER BY created_at, id`,
    [sessionId, normaliseEmail(email), onlyCustomerId],
  );
  const match = rows.find(
    (c) =>
      normaliseName(c.full_name) === normaliseName(fullName) &&
      normalisePostcode(c.postcode) === normalisePostcode(postcode) &&
      normaliseEmail(c.email) === normaliseEmail(email),
  );
  return match ? { customerId: match.id, jobReference: null } : null;
}

async function verified(
  db: Database,
  sessionId: string,
  customerId: string,
  jobReference: string | null,
  alreadyVerified: boolean,
): Promise<VerificationOutcome> {
  const { rows } = await db.query<{ full_name: string }>(
    "SELECT full_name FROM customer WHERE session_id = $1 AND id = $2",
    [sessionId, customerId],
  );
  const jobs = await db.query<VerifiedJobSummary>(
    `SELECT job_reference AS "jobReference", description, job_status AS "jobStatus"
       FROM job
      WHERE session_id = $1 AND customer_id = $2
      ORDER BY job_reference`,
    [sessionId, customerId],
  );
  const named = jobReference ? normaliseJobReference(jobReference) : null;
  return {
    kind: "verified",
    customerId,
    fullName: rows[0]!.full_name,
    jobs: jobs.rows,
    jobReference: named && jobs.rows.some((j) => j.jobReference === named) ? named : null,
    alreadyVerified,
  };
}
