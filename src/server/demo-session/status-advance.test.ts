import { describe, expect, it } from "vitest";
import { InvalidStatusAdvanceError } from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";
import { reply, text } from "@/server/testing/scripted-model-client";
import { chatHarness, toolTurn, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

async function sessionHarness() {
  const h = await createHarness({ now: WEDNESDAY_0930 });
  const sessionId = await h.service.createDemoSession();
  const state = () => h.service.getDashboardState(sessionId);
  return { ...h, sessionId, state };
}

describe("Status advance: one step forward only", () => {
  it("advances a Job through Scheduled → In Progress → Awaiting Parts → Completed", async () => {
    const h = await sessionHarness();
    const job = (await h.state()).jobs.find((j) => j.jobStatus === "Scheduled")!;

    const seen: string[] = [];
    for (const from of ["Scheduled", "In Progress", "Awaiting Parts"] as const) {
      const { jobStatus } = await h.service.advanceJobStatus(h.sessionId, job.id, from);
      seen.push(jobStatus);
    }

    expect(seen).toEqual(["In Progress", "Awaiting Parts", "Completed"]);
    expect((await h.state()).jobs.find((j) => j.id === job.id)!.jobStatus).toBe("Completed");
  });

  it("advances a Parts Order through Ordered → Dispatched → Arrived → Fitted", async () => {
    const h = await sessionHarness();
    const order = (await h.state()).partsOrders.find((p) => p.partsStatus === "Ordered")!;

    const seen: string[] = [];
    for (const from of ["Ordered", "Dispatched", "Arrived"] as const) {
      const { partsStatus } = await h.service.advancePartsStatus(h.sessionId, order.id, from);
      seen.push(partsStatus);
    }

    expect(seen).toEqual(["Dispatched", "Arrived", "Fitted"]);
    expect((await h.state()).partsOrders.find((p) => p.id === order.id)!.partsStatus).toBe("Fitted");
  });

  it("a Parts Order that Arrives shows today as its arrival date", async () => {
    const h = await sessionHarness();
    const order = (await h.state()).partsOrders.find((p) => p.partsStatus === "Dispatched")!;

    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");

    expect((await h.state()).partsOrders.find((p) => p.id === order.id)!.expectedArrival).toBe("2026-11-18");
  });

  it("rejects advancing from terminal states: Completed and Cancelled Jobs, Fitted Parts Orders", async () => {
    const h = await sessionHarness();
    const state = await h.state();
    const completed = state.jobs.find((j) => j.jobStatus === "Completed")!;
    const cancelled = state.jobs.find((j) => j.jobStatus === "Cancelled")!;
    const fitted = state.partsOrders.find((p) => p.partsStatus === "Fitted")!;

    await expect(h.service.advanceJobStatus(h.sessionId, completed.id, "Completed")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    await expect(h.service.advanceJobStatus(h.sessionId, cancelled.id, "Cancelled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    await expect(h.service.advancePartsStatus(h.sessionId, fitted.id, "Fitted")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
  });

  it("rejects a stale advance (the status has moved on), so a double click never skips a step", async () => {
    const h = await sessionHarness();
    const job = (await h.state()).jobs.find((j) => j.jobStatus === "Scheduled")!;

    await h.service.advanceJobStatus(h.sessionId, job.id, "Scheduled");
    await expect(h.service.advanceJobStatus(h.sessionId, job.id, "Scheduled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );

    expect((await h.state()).jobs.find((j) => j.id === job.id)!.jobStatus).toBe("In Progress");
  });

  it("only touches its own Demo Session", async () => {
    const h = await sessionHarness();
    const other = await h.service.createDemoSession();
    const otherJob = (await h.service.getDashboardState(other)).jobs.find((j) => j.jobStatus === "Scheduled")!;

    await expect(h.service.advanceJobStatus(h.sessionId, otherJob.id, "Scheduled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    const after = (await h.service.getDashboardState(other)).jobs.find((j) => j.id === otherJob.id)!;
    expect(after.jobStatus).toBe("Scheduled");
  });
});

/** Verifies Sarah Mitchell (Path A) and returns her Awaiting Parts Job, whose part is Dispatched. */
async function verifiedSarah(h: ChatHarness) {
  const state = await h.service.getDashboardState(h.sessionId);
  const sarah = state.demoCustomers.find((c) => c.fullName === "Sarah Mitchell")!;
  const job = state.jobs.find((j) => j.customer.fullName === "Sarah Mitchell" && j.jobStatus === "Awaiting Parts")!;
  const order = state.partsOrders.find((p) => p.jobReference === job.jobReference)!;
  const verified = await toolTurn(h, "Hi, it's Sarah", "verify_customer", {
    jobReference: job.jobReference,
    postcode: sarah.postcode,
  });
  expect(verified.ok && verified.result.verified).toBe(true);
  return { job, order };
}

describe("Parts Arrived → fitting Visit offer", () => {
  it("while the part is on its way, Job details carry no fitting offer", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job, order } = await verifiedSarah(h);
    expect(order.partsStatus).toBe("Dispatched");

    const details = await toolTurn(h, "Any news on my boiler?", "get_job_details", { jobReference: job.jobReference });

    expect(details.ok && details.result.fittingVisitOffer).toBeNull();
  });

  it("once the presenter advances the part to Arrived, asking in chat yields the fitting offer with Availability", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job, order } = await verifiedSarah(h);

    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");
    const details = await toolTurn(h, "Any news on my boiler?", "get_job_details", { jobReference: job.jobReference });

    expect(details.ok).toBe(true);
    if (!details.ok) return;
    expect(details.result.jobStatus).toBe("Awaiting Parts");
    expect(details.result.fittingVisitOffer).toMatchObject({
      partName: "Diverter valve",
      windows: expect.arrayContaining([expect.objectContaining({ date: expect.any(String), timeWindow: expect.any(String) })]),
    });
    expect(details.result.fittingVisitOffer.windows.length).toBeGreaterThan(0);
    expect(details.result.fittingVisitOffer.guidance).toMatch(/propose_fitting_visit/);
  });
});

describe("Booking the fitting Visit", () => {
  /** Part Arrived, Customer asked, and picked the first offered window. */
  async function proposeFitting(h: ChatHarness) {
    const { job, order } = await verifiedSarah(h);
    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");
    const details = await toolTurn(h, "Any news?", "get_job_details", { jobReference: job.jobReference });
    if (!details.ok) throw new Error(details.error);
    const window = details.result.fittingVisitOffer.windows[0];
    const proposal = await toolTurn(h, "Yes, the first one please", "propose_fitting_visit", {
      jobReference: job.jobReference,
      date: window.date,
      timeWindow: window.timeWindow,
    });
    return { job, window, proposal };
  }

  it("the proposal reads back the fitting Visit and writes nothing until the Customer confirms", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job, window, proposal } = await proposeFitting(h);

    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.readBack).toMatchObject({
      jobReference: job.jobReference,
      partName: "Diverter valve",
      date: window.date,
      timeWindow: window.timeWindow,
    });
    const state = await h.service.getDashboardState(h.sessionId);
    const after = state.jobs.find((j) => j.id === job.id)!;
    expect(after.jobStatus).toBe("Awaiting Parts");
    expect(after.visits).toHaveLength(job.visits.length);
  });

  it("confirming books the Visit on the calendar and returns the Job to Scheduled", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job, window, proposal } = await proposeFitting(h);
    if (!proposal.ok) throw new Error(proposal.error);

    const confirmed = await toolTurn(h, "Yes that's right", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });

    expect(confirmed.ok).toBe(true);
    const state = await h.service.getDashboardState(h.sessionId);
    const after = state.jobs.find((j) => j.id === job.id)!;
    expect(after.jobStatus).toBe("Scheduled");
    expect(after.visits).toHaveLength(job.visits.length + 1);
    const onCalendar = state.calendar.visits.find(
      (v) => v.jobReference === job.jobReference && v.date === window.date && v.timeWindow === window.timeWindow,
    )!;
    expect(onCalendar).toMatchObject({ jobStatus: "Scheduled", customerName: "Sarah Mitchell" });
    const engineer = state.calendar.engineers.find((e) => e.id === onCalendar.engineerId)!;
    expect(engineer.skills).toContain("Boiler Repair");
  });

  it("is refused while the part hasn't Arrived", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job } = await verifiedSarah(h);

    const proposal = await toolTurn(h, "Can you book the fitting?", "propose_fitting_visit", {
      jobReference: job.jobReference,
      date: "2026-11-19",
      timeWindow: "AM",
    });

    expect(proposal.ok).toBe(false);
  });

  it("is refused for an unverified Customer", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const state = await h.service.getDashboardState(h.sessionId);
    // Emma Clarke's seeded Boiler PCB has already Arrived.
    const emmaJob = state.jobs.find((j) => j.customer.fullName === "Emma Clarke" && j.jobStatus === "Awaiting Parts")!;

    const proposal = await toolTurn(h, "Book my fitting", "propose_fitting_visit", {
      jobReference: emmaJob.jobReference,
      date: "2026-11-19",
      timeWindow: "AM",
    });

    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.error).toMatch(/verify_customer/);
  });
});

describe("Status advance → the Agent re-checks Job details", () => {
  /** System messages the model was sent at the start of its latest Customer turn. */
  function latestSystemNotes(h: ChatHarness): string {
    const { messages } = h.model.requests.at(-1)!;
    const i = messages.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
    return JSON.stringify(messages.slice(i + 1).filter((m) => (m.role as string) === "system"));
  }

  async function nextTurnNotes(h: ChatHarness): Promise<string> {
    h.model.script(reply([text("(scripted Agent reply)")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "Any update?");
    return latestSystemNotes(h);
  }

  it("advancing a Parts Order tells the verified Customer's conversation to call get_job_details for that Job", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job, order } = await verifiedSarah(h);
    expect(await nextTurnNotes(h)).not.toContain(job.jobReference);

    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");

    const notes = await nextTurnNotes(h);
    expect(notes).toContain(job.jobReference);
    expect(notes).toContain("get_job_details");
  });

  it("advancing a Job's status tells the verified Customer's conversation to re-check it", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { job } = await verifiedSarah(h);
    await nextTurnNotes(h);

    await h.service.advanceJobStatus(h.sessionId, job.id, "Awaiting Parts");

    const notes = await nextTurnNotes(h);
    expect(notes).toContain(job.jobReference);
    expect(notes).toContain("get_job_details");
  });

  it("conversations not verified for that Customer are not told", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { order, job } = await verifiedSarah(h);
    const stranger: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };

    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");

    expect(await nextTurnNotes(stranger)).not.toContain(job.jobReference);
  });
});
