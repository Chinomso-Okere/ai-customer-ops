import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient } from "@/server/model-client";
import { readDashboardState, type DashboardState } from "./dashboard-state";
import { seedWorld } from "./seed-world";

export interface DemoSessionServiceDeps {
  db: Database;
  clock: Clock;
  modelClient: ModelClient;
}

/** How long a Demo Session lives before cleanup may delete it. */
export const DEMO_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The Demo Session service: the only thing the web layer calls, and the
 * primary test seam (Seam 1).
 */
export interface DemoSessionService {
  /** Creates a Demo Session and seeds its world relative to the clock's "now". */
  createDemoSession(): Promise<string>;
  getDashboardState(sessionId: string): Promise<DashboardState>;
}

export function createDemoSessionService(deps: DemoSessionServiceDeps): DemoSessionService {
  const { db, clock } = deps;

  return {
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

    async getDashboardState(sessionId) {
      return readDashboardState(db, sessionId);
    },
  };
}
