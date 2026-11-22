import { isOtherThanChatCustomer, setChatCustomerIfUnset } from "@/server/chat-customer";
import type { Database } from "@/server/db/database";
import { matchCustomer, type CustomerDetails } from "@/server/scheduling/customer-matching";
import { gasEmergencyBookingBlock } from "../emergency";
import { TOOL_ERRORS, type AgentTurnContext, type ToolOutcome } from "../types";

/**
 * Two-phase Confirmation. A write tool never writes: it validates, then calls
 * `proposeAction` and returns the read-back. `confirm_action` runs the write
 * only if a new Customer message has arrived since the proposal; the model
 * judges whether that message agrees ("yeah go ahead"), the server guarantees
 * the Customer had a turn.
 *
 * Add a kind of write (reschedule, cancellation, fitting Visit...) by defining
 * a `PendingActionKind` and listing it in `./index.ts`.
 */
export interface PendingActionKind<Payload = never> {
  /** Stored on the pending action, e.g. "booking". */
  kind: string;
  /**
   * Set for writes that book nothing (e.g. a cancellation): they may still be
   * confirmed during an unresolved gas/CO Emergency. Everything else is refused.
   */
  allowedDuringGasEmergency?: boolean;
  /**
   * Set for a write that creates or uses a Customer from details the Customer
   * typed (a Booking). `proposeAction` and `confirm_action` then refuse details
   * naming someone other than the chat's Customer (#27), and a confirmed write
   * makes its Customer the chat's. The payload must carry `fullName`,
   * `postcode` and `email`. Leave it off for writes on an already verified
   * Job, and for an Emergency Visit, which is never refused for who it is for.
   */
  bindsChatCustomer?: boolean;
  /**
   * Performs the write, inside a transaction, when the Customer has confirmed.
   * Time has passed since the proposal: re-check anything that may have changed
   * (e.g. Availability). Returning `ok: false` rolls back every write.
   */
  execute(tx: Database, ctx: AgentTurnContext, payload: Payload): Promise<ToolOutcome>;
}

// `any` is deliberate: a registry holds kinds with different payload types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPendingActionKind = PendingActionKind<any>;

/**
 * Records a proposed write and returns the tool outcome carrying its id for
 * `confirm_action`, the read-back and the `guidance` for the model. Earlier
 * pending actions in the conversation are superseded: only the latest
 * read-back can be confirmed. A kind that `bindsChatCustomer` is refused
 * (nothing recorded) when its details name someone other than the chat's Customer.
 */
export async function proposeAction<Payload>(
  ctx: AgentTurnContext,
  kind: PendingActionKind<Payload>,
  action: { payload: Payload; readBack: unknown; guidance: string },
): Promise<ToolOutcome> {
  if (kind.bindsChatCustomer && (await isOtherThanChatCustomer(ctx.db, ctx, customerOf(action.payload)))) {
    return TOOL_ERRORS.oneCustomerPerChat;
  }
  const pendingActionId = await ctx.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE pending_action SET status = 'Superseded', resolved_at = $3
        WHERE session_id = $1 AND conversation_id = $2 AND status = 'Pending'`,
      [ctx.sessionId, ctx.conversationId, ctx.now],
    );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO pending_action
         (session_id, conversation_id, kind, payload, read_back, proposed_at_customer_seq, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7) RETURNING id`,
      [
        ctx.sessionId,
        ctx.conversationId,
        kind.kind,
        JSON.stringify(action.payload),
        JSON.stringify(action.readBack),
        ctx.customerMessage.seq,
        ctx.now,
      ],
    );
    return rows[0]!.id;
  });
  return { ok: true, result: { pendingActionId, readBack: action.readBack, guidance: action.guidance } };
}

/** The Customer details a `bindsChatCustomer` kind's payload carries. */
function customerOf(payload: unknown): CustomerDetails {
  return payload as CustomerDetails;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RolledBack extends Error {
  constructor(readonly outcome: ToolOutcome) {
    super("pending action rolled back");
  }
}

/** Confirms a pending action of this conversation, enforcing two-phase Confirmation. */
export async function confirmAction(
  ctx: AgentTurnContext,
  pendingActionId: string,
  kinds: readonly AnyPendingActionKind[],
): Promise<ToolOutcome> {
  const notFound: ToolOutcome = {
    ok: false,
    error: "No such pending action in this conversation. Propose the action first, read it back, and wait for the Customer to agree.",
  };
  if (!UUID.test(pendingActionId)) return notFound;

  try {
    return await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        kind: string;
        payload: unknown;
        status: string;
        proposed_at_customer_seq: string;
      }>(
        `SELECT kind, payload, status, proposed_at_customer_seq FROM pending_action
          WHERE session_id = $1 AND conversation_id = $2 AND id = $3
          FOR UPDATE`,
        [ctx.sessionId, ctx.conversationId, pendingActionId],
      );
      const action = rows[0];
      if (!action) return notFound;
      if (action.status === "Confirmed") {
        return { ok: false, error: "This action has already been confirmed and carried out. Do not repeat it." };
      }
      if (action.status === "Superseded") {
        return { ok: false, error: "This proposal was replaced by a newer one. Confirm the latest proposal, or propose again." };
      }
      if (action.status !== "Pending") {
        return { ok: false, error: "This proposal can no longer be confirmed. Propose again with up-to-date details." };
      }
      if (ctx.customerMessage.seq <= Number(action.proposed_at_customer_seq)) {
        return {
          ok: false,
          error:
            "Not confirmed: the Customer has not replied since this was proposed. Read the details back, ask the Customer to confirm, and wait for their answer. Call confirm_action in a later turn, only if they agree.",
        };
      }
      const kind = kinds.find((k) => k.kind === action.kind);
      if (!kind) throw new Error(`Unknown pending action kind "${action.kind}"`);
      if (!kind.allowedDuringGasEmergency) {
        // A proposal made before the gas/CO Emergency can't be confirmed during it.
        const blocked = await gasEmergencyBookingBlock({ ...ctx, db: tx });
        if (blocked) return blocked;
      }

      // The chat's Customer may have been set since the proposal (e.g. by Verification).
      if (kind.bindsChatCustomer && (await isOtherThanChatCustomer(tx, ctx, customerOf(action.payload)))) {
        throw new RolledBack(TOOL_ERRORS.oneCustomerPerChat);
      }

      const outcome = await kind.execute(tx, ctx, action.payload);
      if (!outcome.ok) throw new RolledBack(outcome);
      if (kind.bindsChatCustomer) {
        // The write just created or reused this Customer: they are now the chat's.
        const match = await matchCustomer(tx, ctx.sessionId, customerOf(action.payload));
        if (match.kind === "existing") await setChatCustomerIfUnset(tx, ctx, match.customerId);
      }
      await tx.query(
        `UPDATE pending_action SET status = 'Confirmed', result = $4, resolved_at = $5
          WHERE session_id = $1 AND conversation_id = $2 AND id = $3`,
        [ctx.sessionId, ctx.conversationId, pendingActionId, JSON.stringify(outcome.result), ctx.now],
      );
      return outcome;
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
    // The write failed (e.g. the window filled up meanwhile): this proposal is spent.
    await ctx.db.query(
      `UPDATE pending_action SET status = 'Failed', resolved_at = $4
        WHERE session_id = $1 AND conversation_id = $2 AND id = $3 AND status = 'Pending'`,
      [ctx.sessionId, ctx.conversationId, pendingActionId, ctx.now],
    );
    return error.outcome;
  }
}
