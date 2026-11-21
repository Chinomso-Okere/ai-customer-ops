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
import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient } from "@/server/model-client";
import { readDashboardState, type DashboardState } from "./dashboard-state";
import { ConversationNotFoundError, DemoSessionNotFoundError, EmptyCustomerMessageError } from "./errors";
import { seedWorld } from "./seed-world";

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

/**
 * The Demo Session service: the only thing the web layer calls, and the
 * primary test seam (Seam 1). Every operation is scoped to one Demo Session.
 */
export interface DemoSessionService {
  /** Starts a new Demo Session seeded relative to the clock's "now". Reset = call this again. */
  createDemoSession(): Promise<string>;
  /** Resumes `sessionId` if it is live; otherwise starts a new Demo Session. */
  openDemoSession(sessionId: string | undefined): Promise<string>;
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
    async createDemoSession() {
      const now = clock.now();
      const sessionId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO demo_session (id, created_at, expires_at) VALUES ($1, $2, $3)",
          [sessionId, now, new Date(now.getTime() + DEMO_SESSION_TTL_MS)],
        );
        await seedWorld(tx, sessionId, now);
      });
      return sessionId;
    },

    async openDemoSession(sessionId) {
      if (sessionId && (await isLive(sessionId))) return sessionId;
      return service.createDemoSession();
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
  };
  return service;
}
