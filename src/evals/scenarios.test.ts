/**
 * Checks the eval scenarios themselves without the real model: their facts
 * are not satisfied by an Agent that does nothing, and they are satisfied by a
 * scripted Agent that does the right thing. The real-model run is
 * `npm run eval` (agent.eval.ts).
 */
import type { BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelClient } from "@/server/model-client";
import type { DashboardState } from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";
import { reply, text, toolCall } from "@/server/testing/scripted-model-client";
import { DEFAULT_SCENARIO_NOW, runScenario, type Scenario } from "./scenario";
import { SCENARIOS } from "./scenarios";

const doNothingAgent: ModelClient = {
  async createMessage() {
    return reply([text("Sure, anything else?")]);
  },
};

interface PlayedResult {
  name: string;
  ok: boolean;
  result: any;
}
type PlannedCall = readonly [string, Record<string, unknown> | ((results: PlayedResult[]) => Record<string, unknown>)];

/**
 * A scripted Agent: for Customer turn i (0-based, counting turns the
 * pre-filter handled), it makes plan[i]'s tool calls one per model call, then
 * replies with text. Inputs may use every earlier tool result.
 */
function playedAgent(plan: Record<number, PlannedCall[]>): ModelClient {
  const results: PlayedResult[] = [];
  const names: string[] = [];
  let lastTurn = -1;
  let next = 0;
  return {
    async createMessage(request) {
      const messages = request.messages as BetaMessageParam[];
      const turn = messages.filter((m) => m.role === "user" && !isToolResults(m)).length - 1;
      const last = messages.filter((m) => m.role !== "system").at(-1)!;
      if (isToolResults(last)) {
        const block = (last.content as BetaToolResultBlockParam[]).find((b) => b.type === "tool_result")!;
        const content = String(block.content);
        results.push({ name: names.at(-1)!, ok: !block.is_error, result: block.is_error ? content : JSON.parse(content) });
      }
      if (turn !== lastTurn) {
        lastTurn = turn;
        next = 0;
      }
      const call = plan[turn]?.[next++];
      if (!call) return reply([text("(scripted reply)")]);
      const [name, input] = call;
      names.push(name);
      return reply([toolCall(name, typeof input === "function" ? input(results) : input)]);
    },
  };
}

const isToolResults = (m: BetaMessageParam) =>
  m.role === "user" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result");

const latest = (results: PlayedResult[], name: string) => [...results].reverse().find((r) => r.name === name && r.ok)!.result;
const confirmLatest = (name: string): PlannedCall => ["confirm_action", (r) => ({ pendingActionId: latest(r, name).pendingActionId })];

const scenario = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

let seed: DashboardState;
const refOf = (name: string, status: string) =>
  seed.jobs.find((j) => j.customer.fullName === name && j.jobStatus === status)!.jobReference;

beforeAll(async () => {
  const { service } = await createHarness({ now: london(DEFAULT_SCENARIO_NOW) });
  seed = await service.getDashboardState(await service.createDemoSession());
});

describe("Eval scenarios", () => {
  it("are about 20, uniquely named, and each asserts at least one fact", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) expect(s.expect.length, s.id).toBeGreaterThan(0);
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    "%s: a do-nothing Agent fails it unless the server guarantees the facts",
    async (_id, s) => {
      const result = await runScenario(s, { modelClient: doNothingAgent });
      expect(result.passed, JSON.stringify(result.facts)).toBe(s.guaranteedWithoutModel === true);
    },
    60_000,
  );
});

describe("Eval scenarios pass for an Agent that does the right thing", () => {
  const BOOKING = { fullName: "Rosa Delgado", postcode: "SW4 9ZZ", email: "rosa.delgado@example.com", issueType: "Boiler Service" };
  const firstWindow = (r: PlayedResult[]) => {
    const w = latest(r, "get_availability").windows[0];
    return { date: w.date, timeWindow: w.timeWindow };
  };

  it("booking-happy-path", async () => {
    const agent = playedAgent({
      0: [["get_availability", { issueType: "Boiler Service", postcode: BOOKING.postcode }]],
      1: [["propose_booking", (r) => ({ ...BOOKING, ...firstWindow(r) })]],
      2: [confirmLatest("propose_booking")],
    });
    const result = await runScenario(scenario("booking-happy-path"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("natural-language-confirmation", async () => {
    const agent = playedAgent({
      0: [["propose_booking", { fullName: "Ben Hollis", postcode: "SW8 3QT", email: "ben.hollis@example.com", issueType: "Boiler Service", date: "2026-11-20", timeWindow: "AM" }]],
      1: [confirmLatest("propose_booking")],
    });
    const result = await runScenario(scenario("natural-language-confirmation"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("existing-email-booking", async () => {
    const details = { fullName: "Sally Mitchell", postcode: "SW4 7AB", email: "sarah.mitchell@example.com", issueType: "Radiators & Heating" };
    const agent = playedAgent({
      0: [["get_availability", { issueType: details.issueType, postcode: details.postcode }]],
      1: [["propose_booking", (r) => ({ ...details, ...firstWindow(r) })]],
      2: [confirmLatest("propose_booking")],
    });
    const result = await runScenario(scenario("existing-email-booking"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("verification-lockout", async () => {
    const ref = refOf("Sarah Mitchell", "Awaiting Parts");
    const agent = playedAgent({
      0: [["verify_customer", { jobReference: ref, postcode: "SW4 7AA" }]],
      1: [["verify_customer", { jobReference: ref, email: "sarah.mitchel@example.co.uk" }]],
      2: [["verify_customer", { jobReference: ref, postcode: "SW4 1AB" }]],
      3: [["get_job_details", { jobReference: ref }]],
    });
    const result = await runScenario(scenario("verification-lockout"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("operator-advances-part-to-arrived", async () => {
    const ref = refOf("Sarah Mitchell", "Awaiting Parts");
    const agent = playedAgent({
      0: [
        ["verify_customer", { jobReference: ref, postcode: "SW4 7AB" }],
        ["get_job_details", { jobReference: ref }],
      ],
      1: [
        ["propose_fitting_visit", (r) => {
          const w = latest(r, "get_job_details").fittingVisitOffer.windows[0];
          return { jobReference: ref, date: w.date, timeWindow: w.timeWindow };
        }],
      ],
      2: [confirmLatest("propose_fitting_visit")],
    });
    const result = await runScenario(scenario("operator-advances-part-to-arrived"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("reschedule-over-24h", async () => {
    const ref = refOf("James Patel", "Scheduled");
    // The scenario picks the target window as it speaks; capture it for the played Agent.
    let target = { date: "", timeWindow: "" };
    const s = scenario("reschedule-over-24h");
    const capturing: Scenario = {
      ...s,
      steps: s.steps.map((step) => {
        if (!("customer" in step) || typeof step.customer !== "function") return step;
        const speak = step.customer;
        return {
          customer: async (w) => {
            const said = await speak(w);
            if (w.vars.target) target = w.vars.target as typeof target;
            return said;
          },
        };
      }),
    };
    const agent = playedAgent({
      0: [
        ["verify_customer", { jobReference: ref, email: "james.patel@example.com" }],
        ["get_job_details", { jobReference: ref }],
      ],
      1: [["propose_reschedule", (r) => ({ visitId: latest(r, "get_job_details").upcomingVisits[0].visitId, ...target })]],
      2: [confirmLatest("propose_reschedule")],
    });
    const result = await runScenario(capturing, { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("late-cancellation-out-of-policy", async () => {
    const ref = refOf("George Adeyemi", "Scheduled");
    const agent = playedAgent({
      0: [
        ["verify_customer", { jobReference: ref, postcode: "SW9 9QP" }],
        ["get_job_details", { jobReference: ref }],
        ["propose_cancellation", (r) => ({ visitId: latest(r, "get_job_details").upcomingVisits[0].visitId })],
      ],
    });
    const result = await runScenario(scenario("late-cancellation-out-of-policy"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("duplicate-ticket-suppression", async () => {
    const complaint = { reason: "Complaint", summary: "Engineer late and messy.", recommendedNextStep: "Call the Customer." };
    const agent = playedAgent({
      0: [["create_handoff_ticket", complaint]],
      1: [["create_handoff_ticket", { ...complaint, summary: "Also nobody phoned ahead." }]],
    });
    const result = await runScenario(scenario("duplicate-ticket-suppression"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("flood-emergency-visit", async () => {
    const agent = playedAgent({
      1: [["propose_emergency_visit", { fullName: "Nadia Okoro", postcode: "SE15 2AB", email: "nadia.okoro@example.com", issueType: "Boiler Repair" }]],
      2: [confirmLatest("propose_emergency_visit")],
    });
    const result = await runScenario(scenario("flood-emergency-visit"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  const outOfPolicy = { reason: "Out of Policy", summary: "Customer asked for something the Agent can't grant.", recommendedNextStep: "Review." };
  const played: Array<[string, () => Record<number, PlannedCall[]>]> = [
    ["out-of-area-postcode", () => ({ 0: [["check_coverage_area", { postcode: "M1 1AE" }]] })],
    ["negated-gas-routine-booking", () => ({
      0: [["get_availability", { issueType: "Boiler Service", postcode: "SE22 8XY" }]],
      1: [["propose_booking", (r) => ({ fullName: "Hannah Webb", postcode: "SE22 8XY", email: "hannah.webb@example.com", issueType: "Boiler Service", ...firstWindow(r) })]],
      2: [confirmLatest("propose_booking")],
    })],
    ["path-a-verification", () => {
      const ref = refOf("James Patel", "Scheduled");
      return { 0: [["verify_customer", { jobReference: ref, email: "james.patel@example.com" }], ["get_job_details", { jobReference: ref }]] };
    }],
    ["path-b-verification", () => ({
      0: [["verify_customer", { fullName: "Emma Clarke", postcode: "SW11 2PL", email: "emma.clarke@example.com" }]],
      1: [["get_job_details", { jobReference: refOf("Emma Clarke", "Awaiting Parts") }]],
    })],
    ["nickname-failure-then-reminder", () => ({
      0: [["verify_customer", { fullName: "Jim Patel", postcode: "SE15 4QF", email: "james.patel@example.com" }]],
      1: [["verify_customer", { fullName: "James Patel", postcode: "SE15 4QF", email: "james.patel@example.com" }]],
    })],
    ["wheres-my-part", () => {
      const ref = refOf("Sarah Mitchell", "Awaiting Parts");
      return { 0: [["verify_customer", { jobReference: ref, postcode: "SW4 7AB" }], ["get_job_details", { jobReference: ref }]] };
    }],
    ["part-arrived-fitting-visit", () => {
      const ref = refOf("Emma Clarke", "Awaiting Parts");
      return {
        0: [["verify_customer", { jobReference: ref, email: "emma.clarke@example.com" }], ["get_job_details", { jobReference: ref }]],
        1: [["propose_fitting_visit", (r) => {
          const w = latest(r, "get_job_details").fittingVisitOffer.windows[0];
          return { jobReference: ref, date: w.date, timeWindow: w.timeWindow };
        }]],
        2: [confirmLatest("propose_fitting_visit")],
      };
    }],
    ["refund-request", () => ({ 0: [["create_handoff_ticket", outOfPolicy]] })],
    ["fifty-pound-price", () => ({ 1: [["create_handoff_ticket", outOfPolicy]] })],
    ["angry-customer-complaint", () => ({
      0: [["create_handoff_ticket", { reason: "Complaint", summary: "Engineer late and messy.", recommendedNextStep: "Call the Customer." }]],
    })],
    ["off-topic-refusal", () => ({ 0: [["refuse_off_topic", {}]] })],
    ["emergency-contact-details", () => ({
      1: [["create_handoff_ticket", { reason: "Emergency", summary: "Contact details for the callback.", recommendedNextStep: "Call the Customer.", customerName: "Priya Nair", customerPhone: "07700 900123" }]],
    })],
  ];

  it.each(played)("%s", async (id, plan) => {
    const result = await runScenario(scenario(id), { modelClient: playedAgent(plan()) });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });

  it("every scenario has a played-Agent check above", () => {
    const covered = new Set([
      ...played.map(([id]) => id),
      "booking-happy-path", "natural-language-confirmation", "existing-email-booking", "verification-lockout",
      "operator-advances-part-to-arrived", "reschedule-over-24h", "late-cancellation-out-of-policy",
      "duplicate-ticket-suppression", "flood-emergency-visit", "gas-leak-booking-blocked",
    ]);
    expect(SCENARIOS.map((s) => s.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it("gas-leak-booking-blocked holds even when the Agent tries to book", async () => {
    const agent = playedAgent({
      1: [["propose_booking", { fullName: "Liam Foster", postcode: "SW4 1AA", email: "liam.foster@example.com", issueType: "Boiler Service", date: "2026-11-19", timeWindow: "AM" }]],
    });
    const result = await runScenario(scenario("gas-leak-booking-blocked"), { modelClient: agent });
    expect(result.facts.filter((f) => !f.ok)).toEqual([]);
  });
});
