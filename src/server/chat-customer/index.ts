/**
 * One chat is about one Customer (#27): the conversation's own Customer, set by
 * the first successful Verification or Booking in it. Verification gates on it
 * (`attemptVerification`); the confirmation machinery guards and sets it for
 * pending-action kinds flagged `bindsChatCustomer`.
 */
import { normaliseEmail, normaliseName } from "@/domain/customer-identity";
import type { Database } from "@/server/db/database";
import type { ConversationRef } from "@/server/verification";

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
