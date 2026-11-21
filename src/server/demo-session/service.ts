import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient } from "@/server/model-client";
import { readDashboardState, type DashboardState } from "./dashboard-state";
import { DemoSessionNotFoundError } from "./errors";
import { seedWorld } from "./seed-world";

export interface DemoSessionServiceDeps {
  db: Database;
  clock: Clock;
  modelClient: ModelClient;
}

/** How long a Demo Session lives before it expires and cleanup may delete it. */
export const DEMO_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDemoSessionService(deps: DemoSessionServiceDeps): DemoSessionService {
  const { db, clock } = deps;

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
  };
  return service;
}
