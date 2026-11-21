import { createHash } from "node:crypto";
import {
  AGENT_TOOLS,
  PRE_MODEL_HOOKS,
  createAgentRunner,
  type AgentTool,
  type ChatMessage,
  type CustomerTurnResult,
  type PreModelHook,
} from "@/server/agent";
import * as conversations from "@/server/agent/conversation-store";
import type { JobStatus, PartsStatus } from "@/domain/vocabulary";
import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient } from "@/server/model-client";
import { readDashboardState, type DashboardState } from "./dashboard-state";
import {
  ConversationNotFoundError,
  DemoSessionNotFoundError,
  DemoSessionRateLimitedError,
  EmptyCustomerMessageError,
  InvalidStatusAdvanceError,
} from "./errors";
import { seedWorld } from "./seed-world";
import * as statusAdvance from "./status-advance";

export interface DemoSessionServiceDeps {
  db: Database;
  clock: Clock;
  modelClient: ModelClient;
  /** Overrides the tool registry (`src/server/agent/tools`). Tests of the runner's mechanics only. */
  agentTools?: readonly AgentTool[];
  /** Overrides the pre-model hook registry (`src/server/agent/hooks`). Tests of the runner's mechanics only. */
  preModelHooks?: readonly PreModelHook[];
}

/** How long a Demo Session lives before it expires and cleanup may delete it. */
export const DEMO_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/** Longest Customer message the Agent accepts, in characters; longer ones are truncated. */
export const MAX_CUSTOMER_MESSAGE_LENGTH = 2000;

/** Abuse guardrail: new Demo Sessions one client IP may start per rolling hour. */
export const MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export interface NewDemoSessionOptions {
  /** The visitor's IP. When given, new Demo Sessions are rate limited per IP. */
  clientIp?: string;
}

/**
 * The Demo Session service: the only thing the web layer calls, and the
 * primary test seam (Seam 1). Every operation is scoped to one Demo Session.
 */
export interface DemoSessionService {
  /**
   * Starts a new Demo Session seeded relative to the clock's "now". Reset = call this again.
   * @throws DemoSessionRateLimitedError past MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR for `clientIp`
   */
  createDemoSession(options?: NewDemoSessionOptions): Promise<string>;
  /**
   * Resumes `sessionId` if it is live; otherwise starts a new Demo Session.
   * @throws DemoSessionRateLimitedError (only when it would start a new one)
   */
  openDemoSession(sessionId: string | undefined, options?: NewDemoSessionOptions): Promise<string>;
  /** @throws DemoSessionNotFoundError if the session is unknown or expired. */
  getDashboardState(sessionId: string): Promise<DashboardState>;
  /**
   * Resumes the conversation if it belongs to this live Demo Session; otherwise
   * starts a new one. @throws DemoSessionNotFoundError
   */
  openConversation(sessionId: string, conversationId: string | undefined): Promise<string>;
  /** The Customer-visible transcript. @throws DemoSessionNotFoundError, ConversationNotFoundError */
  getConversation(sessionId: string, conversationId: string): Promise<ChatMessage[]>;
  /**
   * Runs one Customer turn through the Agent: pre-model hooks, then the tool
   * loop. Turns in one conversation run one at a time.
   * @throws DemoSessionNotFoundError, ConversationNotFoundError, EmptyCustomerMessageError
   */
  sendCustomerMessage(
    sessionId: string,
    conversationId: string,
    text: string,
  ): Promise<CustomerTurnResult>;
  /**
   * Cleanup: deletes every Demo Session past its TTL with all its data (every
   * session-scoped table cascades from `demo_session`). Live sessions are
   * untouched. Run on a schedule (see README "Expired-session cleanup").
   * @returns the deleted Demo Session ids
   */
  deleteExpiredDemoSessions(): Promise<string[]>;
  /**
   * Presenter control: moves a Job one step forward along Scheduled → In
   * Progress → Awaiting Parts → Completed. `from` is the status the Operator
   * saw. @throws InvalidStatusAdvanceError at a terminal status, if `from` is
   * stale, or if the Job isn't in this session; DemoSessionNotFoundError
   */
  advanceJobStatus(sessionId: string, jobId: string, from: JobStatus): Promise<{ jobStatus: JobStatus }>;
  /**
   * Presenter control: moves a Parts Order one step forward along Ordered →
   * Dispatched → Arrived → Fitted. Arriving doesn't change the Job: it stays
   * Awaiting Parts until a fitting Visit is booked.
   * @throws InvalidStatusAdvanceError, DemoSessionNotFoundError
   */
  advancePartsStatus(
    sessionId: string,
    partsOrderId: string,
    from: PartsStatus,
  ): Promise<{ partsStatus: PartsStatus }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDemoSessionService(deps: DemoSessionServiceDeps): DemoSessionService {
  const { db, clock } = deps;
  const runner = createAgentRunner({
    db,
    clock,
    modelClient: deps.modelClient,
    tools: deps.agentTools ?? AGENT_TOOLS,
    preModelHooks: deps.preModelHooks ?? PRE_MODEL_HOOKS,
  });
  const conversationLocks = new Map<string, Promise<unknown>>();

  /** Serialises turns per conversation (in-process), so a history never interleaves. */
  function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = conversationLocks.get(conversationId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    conversationLocks.set(conversationId, settled);
    void settled.then(() => {
      if (conversationLocks.get(conversationId) === settled) conversationLocks.delete(conversationId);
    });
    return next;
  }

  async function isLive(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId || !UUID.test(sessionId)) return false;
    const { rows } = await db.query(
      "SELECT 1 FROM demo_session WHERE id = $1 AND expires_at > $2",
      [sessionId, clock.now()],
    );
    return rows.length > 0;
  }

  async function requireLive(sessionId: string): Promise<void> {
    if (!(await isLive(sessionId))) throw new DemoSessionNotFoundError(sessionId);
  }

  async function findConversation(sessionId: string, conversationId: string): Promise<Date | null> {
    if (!UUID.test(conversationId)) return null;
    return conversations.conversationStartedAt(db, sessionId, conversationId);
  }

  /** @returns when the conversation started. */
  async function requireConversation(sessionId: string, conversationId: string): Promise<Date> {
    await requireLive(sessionId);
    const startedAt = await findConversation(sessionId, conversationId);
    if (!startedAt) throw new ConversationNotFoundError(conversationId);
    return startedAt;
  }

  const service: DemoSessionService = {
    async createDemoSession(options) {
      const now = clock.now();
      const sessionId = crypto.randomUUID();
      const ipHash = options?.clientIp ? hashClientIp(options.clientIp) : null;
      await db.transaction(async (tx) => {
        if (ipHash) {
          // Serialise creations per IP so concurrent requests can't all slip under the limit.
          await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ipHash]);
          const { rows } = await tx.query<{ n: string }>(
            "SELECT count(*) AS n FROM demo_session WHERE client_ip_hash = $1 AND created_at > $2",
            [ipHash, new Date(now.getTime() - RATE_LIMIT_WINDOW_MS)],
          );
          if (Number(rows[0]!.n) >= MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR) {
            throw new DemoSessionRateLimitedError();
          }
        }
        await tx.query(
          "INSERT INTO demo_session (id, created_at, expires_at, client_ip_hash) VALUES ($1, $2, $3, $4)",
          [sessionId, now, new Date(now.getTime() + DEMO_SESSION_TTL_MS), ipHash],
        );
        await seedWorld(tx, sessionId, now);
      });
      return sessionId;
    },

    async openDemoSession(sessionId, options) {
      if (sessionId && (await isLive(sessionId))) return sessionId;
      return service.createDemoSession(options);
    },

    async getDashboardState(sessionId) {
      await requireLive(sessionId);
      return readDashboardState(db, sessionId, clock.now());
    },

    async openConversation(sessionId, conversationId) {
      await requireLive(sessionId);
      if (conversationId && (await findConversation(sessionId, conversationId))) return conversationId;
      return conversations.createConversation(db, sessionId, clock.now());
    },

    async getConversation(sessionId, conversationId) {
      await requireConversation(sessionId, conversationId);
      return conversations.readChatMessages(db, sessionId, conversationId);
    },

    async sendCustomerMessage(sessionId, conversationId, text) {
      const customerText = text.trim().slice(0, MAX_CUSTOMER_MESSAGE_LENGTH);
      if (!customerText) throw new EmptyCustomerMessageError();
      return withConversationLock(conversationId, async () => {
        const startedAt = await requireConversation(sessionId, conversationId);
        const replies = await runner.runCustomerTurn(sessionId, conversationId, startedAt, customerText);
        const conversation = await conversations.readChatMessages(db, sessionId, conversationId);
        return { replies, conversation };
      });
    },

    async deleteExpiredDemoSessions() {
      const { rows } = await db.query<{ id: string }>(
        "DELETE FROM demo_session WHERE expires_at <= $1 RETURNING id",
        [clock.now()],
      );
      return rows.map((r) => r.id);
    },

    async advanceJobStatus(sessionId, jobId, from) {
      await requireLive(sessionId);
      if (!UUID.test(jobId)) throw new InvalidStatusAdvanceError("No such Job in this Demo Session.");
      return statusAdvance.advanceJobStatus(db, sessionId, jobId, from);
    },

    async advancePartsStatus(sessionId, partsOrderId, from) {
      await requireLive(sessionId);
      if (!UUID.test(partsOrderId)) throw new InvalidStatusAdvanceError("No such Parts Order in this Demo Session.");
      return statusAdvance.advancePartsStatus(db, sessionId, partsOrderId, from, clock.now());
    },
  };
  return service;
}

/**
 * The IP is personal data, so only a salted hash is stored. Set
 * DEMO_SESSION_IP_SALT in production so hashes can't be reversed by brute force.
 */
function hashClientIp(clientIp: string): string {
  const salt = process.env.DEMO_SESSION_IP_SALT ?? "apex-demo";
  return createHash("sha256").update(`${salt}:${clientIp.trim()}`).digest("hex");
}
