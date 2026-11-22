import { describe, expect, it } from "vitest";
import { MESSAGE_CAP_REPLY, MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION } from "@/server/agent";
import type { Database } from "@/server/db/database";
import {
  DemoSessionNotFoundError,
  DemoSessionRateLimitedError,
  MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR,
} from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";
import { ScriptedModelClient, reply, text } from "@/server/testing/scripted-model-client";

const WEDNESDAY = london("2026-11-18T11:30");

describe("Guardrails", () => {
  it("the 41st message to the Agent in a Demo Session is refused without calling the model", async () => {
    const model = new ScriptedModelClient();
    const { service } = await createHarness({ now: WEDNESDAY, modelClient: model });
    const sessionId = await service.createDemoSession();
    // The cap counts across every conversation in the Demo Session.
    const first = await service.openConversation(sessionId, undefined);
    const second = await service.openConversation(sessionId, undefined);
    expect(MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION).toBe(40);

    for (let i = 1; i <= 40; i++) {
      model.script(reply([text(`Reply ${i}`)]));
      const result = await service.sendCustomerMessage(sessionId, i <= 20 ? first : second, `Message ${i}`);
      expect(result.replies[0]).toMatchObject({ kind: "text", text: `Reply ${i}` });
    }
    expect(model.requests).toHaveLength(40);

    const capped = await service.sendCustomerMessage(sessionId, second, "Message 41");
    expect(model.requests).toHaveLength(40);
    expect(capped.replies).toEqual([
      expect.objectContaining({ speaker: "Agent", kind: "message_cap", text: MESSAGE_CAP_REPLY }),
    ]);
    // It stays capped, in a new conversation too; other Demo Sessions are unaffected.
    const third = await service.openConversation(sessionId, undefined);
    const again = await service.sendCustomerMessage(sessionId, third, "Hello?");
    expect(again.replies[0]!.kind).toBe("message_cap");
    expect(model.requests).toHaveLength(40);

    const otherSession = await service.createDemoSession();
    const otherConversation = await service.openConversation(otherSession, undefined);
    model.script(reply([text("Hi!")]));
    const other = await service.sendCustomerMessage(otherSession, otherConversation, "Hi");
    expect(other.replies[0]!.kind).toBe("text");
  });

  it("an Emergency past the message cap still gets the Safety Script and a Critical ticket", async () => {
    const model = new ScriptedModelClient();
    const { service } = await createHarness({ now: WEDNESDAY, modelClient: model });
    const sessionId = await service.createDemoSession();
    const conversationId = await service.openConversation(sessionId, undefined);
    for (let i = 1; i <= MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION; i++) {
      model.script(reply([text(`Reply ${i}`)]));
      await service.sendCustomerMessage(sessionId, conversationId, `Message ${i}`);
    }
    expect((await service.sendCustomerMessage(sessionId, conversationId, "Hello?")).replies[0]!.kind).toBe(
      "message_cap",
    );

    const emergency = await service.sendCustomerMessage(sessionId, conversationId, "I smell gas");
    expect(emergency.replies.map((r) => r.kind)).toEqual(["safety_script", "handoff_notice"]);
    expect(model.requests).toHaveLength(MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION);
  });

  it("at most 10 new Demo Sessions per IP per hour; the 11th is refused until the hour has passed", async () => {
    const { service, clock } = await createHarness({ now: WEDNESDAY });
    const ip = "203.0.113.7";
    expect(MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR).toBe(10);

    const first = await service.createDemoSession({ clientIp: ip });
    clock.set(london("2026-11-18T11:50"));
    for (let i = 0; i < 8; i++) await service.createDemoSession({ clientIp: ip });
    await service.openDemoSession(undefined, { clientIp: ip });
    clock.set(london("2026-11-18T12:29"));
    await expect(service.createDemoSession({ clientIp: ip })).rejects.toBeInstanceOf(
      DemoSessionRateLimitedError,
    );
    await expect(service.openDemoSession("not-a-session", { clientIp: ip })).rejects.toBeInstanceOf(
      DemoSessionRateLimitedError,
    );
    // Resuming a live Demo Session is not a new one; other IPs are unaffected.
    expect(await service.openDemoSession(first, { clientIp: ip })).toBe(first);
    await service.createDemoSession({ clientIp: "198.51.100.20" });

    // An hour after the first, one more is allowed (then refused again).
    clock.set(london("2026-11-18T12:30"));
    await service.createDemoSession({ clientIp: ip });
    await expect(service.createDemoSession({ clientIp: ip })).rejects.toBeInstanceOf(
      DemoSessionRateLimitedError,
    );
  });

  // Each test uses its own IP: one database is shared per file and the limit counts per IP.
  describe("reset", () => {
    it("replaces the Demo Session, so resetting many times in a row never hits the rate limit", async () => {
      const { service } = await createHarness({ now: WEDNESDAY });
      const ip = "203.0.113.10";

      let current = await service.createDemoSession({ clientIp: ip });
      for (let i = 0; i < MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR * 2; i++) {
        const next = await service.resetDemoSession(current, { clientIp: ip });
        expect(next).not.toBe(current);
        current = next;
      }
      expect((await service.getDashboardState(current)).sessionId).toBe(current);
    });

    it("deletes the old Demo Session with its Jobs, tickets and chat", async () => {
      const model = new ScriptedModelClient();
      const { service, db } = await createHarness({ now: WEDNESDAY, modelClient: model });
      const old = await service.createDemoSession({ clientIp: "203.0.113.20" });
      const conversationId = await service.openConversation(old, undefined);
      model.script(reply([text("Hello!")]));
      await service.sendCustomerMessage(old, conversationId, "Hi");
      await service.sendCustomerMessage(old, conversationId, "I smell gas");
      expect(Object.keys(await rowsScopedTo(db, old))).toEqual(
        expect.arrayContaining(["job", "handoff_ticket", "chat_message"]),
      );

      const next = await service.resetDemoSession(old, { clientIp: "203.0.113.20" });

      await expect(service.getDashboardState(old)).rejects.toBeInstanceOf(DemoSessionNotFoundError);
      expect(await rowsScopedTo(db, old)).toEqual({});
      expect(next).not.toBe(old);
      expect((await service.getDashboardState(next)).sessionId).toBe(next);
    });

    it("still refuses when the caller has no live Demo Session and the IP is at the limit", async () => {
      const { service } = await createHarness({ now: WEDNESDAY });
      const ip = "203.0.113.11";
      for (let i = 0; i < MAX_NEW_DEMO_SESSIONS_PER_IP_PER_HOUR; i++) {
        await service.createDemoSession({ clientIp: ip });
      }
      await expect(service.resetDemoSession(undefined, { clientIp: ip })).rejects.toBeInstanceOf(
        DemoSessionRateLimitedError,
      );
      await expect(service.resetDemoSession("not-a-session", { clientIp: ip })).rejects.toBeInstanceOf(
        DemoSessionRateLimitedError,
      );
    });

    it("session isolation: deletes only the caller's own Demo Session, never another from the same IP", async () => {
      const { service } = await createHarness({ now: WEDNESDAY });
      const ip = "203.0.113.12";
      const mine = await service.createDemoSession({ clientIp: ip });
      const sameIp = await service.createDemoSession({ clientIp: ip });
      const otherIp = await service.createDemoSession({ clientIp: "198.51.100.20" });
      const sameIpBefore = await service.getDashboardState(sameIp);
      const otherIpBefore = await service.getDashboardState(otherIp);

      await service.resetDemoSession(mine, { clientIp: ip });
      // A reset with no cookie deletes nothing: the IP alone never selects a Demo Session.
      await service.resetDemoSession(undefined, { clientIp: ip });

      expect(await service.getDashboardState(sameIp)).toEqual(sameIpBefore);
      expect(await service.getDashboardState(otherIp)).toEqual(otherIpBefore);
    });
  });

  it("cleanup deletes expired Demo Sessions with all their data, and leaves live ones untouched", async () => {
    const model = new ScriptedModelClient();
    const { service, clock, db } = await createHarness({ now: WEDNESDAY, modelClient: model });
    const withChat = async () => {
      const sessionId = await service.createDemoSession();
      const conversationId = await service.openConversation(sessionId, undefined);
      model.script(reply([text("Hello!")]));
      await service.sendCustomerMessage(sessionId, conversationId, "Hi");
      return { sessionId, conversationId };
    };
    const expired = await withChat(); // created 11:30, expires 15:30
    // An Emergency gives it a Handoff Ticket with a timeline (handoff_ticket_event) too.
    await service.sendCustomerMessage(expired.sessionId, expired.conversationId, "I smell gas");
    expect(Object.keys(await rowsScopedTo(db, expired.sessionId))).toEqual(
      expect.arrayContaining(["handoff_ticket", "handoff_ticket_event"]),
    );
    clock.set(london("2026-11-18T14:00"));
    const live = await withChat(); // created 14:00, expires 18:00
    const liveBefore = await service.getDashboardState(live.sessionId);

    clock.set(london("2026-11-18T15:31"));
    const deleted = await service.deleteExpiredDemoSessions();

    expect(deleted).toContain(expired.sessionId);
    expect(deleted).not.toContain(live.sessionId);
    // Every row of every session-scoped table is gone for the expired session.
    expect(await rowsScopedTo(db, expired.sessionId)).toEqual({});
    expect(Object.keys(await rowsScopedTo(db, live.sessionId))).toEqual(
      expect.arrayContaining(["demo_session", "customer", "job", "visit", "chat_message", "agent_message"]),
    );
    expect(await service.getDashboardState(live.sessionId)).toEqual(liveBefore);
    expect(await service.getConversation(live.sessionId, live.conversationId)).toHaveLength(2);
    // Running it again finds nothing new to delete.
    expect(await service.deleteExpiredDemoSessions()).not.toContain(expired.sessionId);
  });
});

/**
 * Row counts per table for one Demo Session, over every table with a
 * `session_id` (found from the schema, so future tables are covered too).
 * Deleted data is unreachable through the service by design, so this one
 * check reads the database directly.
 */
async function rowsScopedTo(db: Database, sessionId: string): Promise<Record<string, number>> {
  const { rows: tables } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'session_id' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  const session = await db.query<{ n: string }>("SELECT count(*) AS n FROM demo_session WHERE id = $1", [sessionId]);
  if (Number(session.rows[0]!.n) > 0) counts.demo_session = Number(session.rows[0]!.n);
  for (const { table_name } of tables) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${table_name}" WHERE session_id = $1`,
      [sessionId],
    );
    if (Number(rows[0]!.n) > 0) counts[table_name] = Number(rows[0]!.n);
  }
  return counts;
}
