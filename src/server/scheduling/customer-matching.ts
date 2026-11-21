import { normalisePostcode } from "@/domain/coverage-area";
import type { Database } from "@/server/db/database";
import { normaliseEmail, normaliseName } from "@/server/verification";

export interface CustomerDetails {
  fullName: string;
  postcode: string;
  email: string;
}

/**
 * How a Booking's details relate to the Customers already in this Demo Session:
 * - `existing`: email, full name and postcode all match; book under that Customer.
 * - `possibleDuplicate`: only the email matches; book under a new Customer flagged
 *   as a possible duplicate of `ofCustomerId` for an Operator to merge.
 * - `new`: the email is not on file.
 * Never shown to the Agent: its tool results must not reveal whether an email exists.
 */
export type CustomerMatch =
  | { kind: "existing"; customerId: string }
  | { kind: "possibleDuplicate"; ofCustomerId: string }
  | { kind: "new" };

export async function matchCustomer(
  db: Database,
  sessionId: string,
  details: CustomerDetails,
): Promise<CustomerMatch> {
  const { rows } = await db.query<{ id: string; full_name: string; postcode: string; email: string }>(
    `SELECT id, full_name, postcode, email
       FROM customer
      WHERE session_id = $1 AND lower(regexp_replace(email, '\\s', '', 'g')) = $2
      ORDER BY created_at, id`,
    [sessionId, normaliseEmail(details.email)],
  );
  const full = rows.find(
    (c) =>
      normaliseName(c.full_name) === normaliseName(details.fullName) &&
      normalisePostcode(c.postcode) === normalisePostcode(details.postcode),
  );
  if (full) return { kind: "existing", customerId: full.id };
  if (rows[0]) return { kind: "possibleDuplicate", ofCustomerId: rows[0].id };
  return { kind: "new" };
}
