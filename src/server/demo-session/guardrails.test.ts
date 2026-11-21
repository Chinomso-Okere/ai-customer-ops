import { describe, expect, it } from "vitest";
import { MESSAGE_CAP_REPLY, MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION } from "@/server/agent";
import { createHarness, london } from "@/server/testing/harness";
import { reply, text } from "@/server/testing/scripted-model-client";

const WEDNESDAY = london("2026-11-18T11:30");

describe("Guardrails", () => {
  it("the 41st message to the Agent in a Demo Session is refused without calling the model", async () => {
    const { service, model } = await createHarness({ now: WEDNESDAY });
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
});
