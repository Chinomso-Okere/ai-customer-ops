/**
 * Dev-only scripted model (`AGENT_MODEL=scripted npm run dev`): drives the chat
 * UI in a browser without the paid Anthropic key. It is a small keyword router,
 * not a model: it reads the Customer's words and the tool results already in
 * the request, and replies with a tool call or text. It keeps no state of its
 * own, so it works across turns and server restarts of the same conversation.
 *
 * Never reachable in production: `src/server/runtime.ts` imports this file
 * only behind a `NODE_ENV !== "production"` check, which the production build
 * folds away, and refuses `AGENT_MODEL=scripted` there.
 */
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient, ModelRequest, ModelResponse } from "@/server/model-client";
import { PRICE_LIST } from "@/server/agent/price-list";
import { ISSUE_TYPES, type IssueType } from "@/domain/vocabulary";
import { assertValidMessages, reply, text, toolCall } from "./scripted-model-client";

export class DevScriptedModelClient implements ModelClient {
  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    assertValidMessages(request.messages);
    return route(requestContext(request.messages));
  }
}

// ---------------------------------------------------------------------------
// Reading the conversation

interface ToolRun {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Parsed JSON result; for a plain-text error, `{ error }`. */
  data: Record<string, any>;
  /** Index in `messages` of the user message carrying the result. */
  at: number;
}

const isCustomerMessage = (m: BetaMessageParam) => m.role === "user" && typeof m.content === "string";

/** Every tool call in the conversation with its result, oldest first. */
function toolRuns(messages: readonly BetaMessageParam[]): ToolRun[] {
  const uses = new Map<string, BetaToolUseBlock>();
  const runs: ToolRun[] = [];
  messages.forEach((m, at) => {
    if (typeof m.content === "string") return;
    const blocks = m.content as (BetaContentBlock | BetaToolResultBlockParam)[];
    for (const block of blocks) {
      if (block.type === "tool_use") uses.set(block.id, block);
    }
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const use = uses.get(block.tool_use_id);
      if (!use) continue;
      const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      let data: Record<string, any>;
      try {
        data = JSON.parse(raw) as Record<string, any>;
      } catch {
        data = { error: raw };
      }
      runs.push({
        name: use.name,
        input: use.input as Record<string, unknown>,
        ok: !block.is_error,
        data,
        at,
      });
    }
  });
  return runs;
}

const customerTexts = (messages: readonly BetaMessageParam[]): string[] =>
  messages.filter(isCustomerMessage).map((m) => m.content as string);

/** Everything the router reads from one request, worked out once. */
interface RequestContext {
  messages: readonly BetaMessageParam[];
  runs: ToolRun[];
  /** Every Customer message, oldest first. */
  texts: string[];
  /** The Customer's latest message. */
  latestText: string;
  details: Details;
}

function requestContext(messages: readonly BetaMessageParam[]): RequestContext {
  const texts = customerTexts(messages);
  return { messages, runs: toolRuns(messages), texts, latestText: last(texts)!, details: detailsFrom(texts) };
}

// ---------------------------------------------------------------------------
// Extracting what the Customer said (kept as typed: the tools normalise)

const EMAIL = /[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]*[A-Za-z0-9]/;
const POSTCODE = /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/;
const JOB_REFERENCE = /\bAPX-?\d{3,}\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const NOT_NAME_WORDS = new Set(
  "hi hello hey i i'm i'd i'll my it's this is the a please thanks thank you apex boiler heat radiators ac book where what when can could would yes no ok okay".split(" "),
);

const last = <T>(items: T[]): T | undefined => items[items.length - 1];

function lastMatch(texts: string[], pattern: RegExp): string | undefined {
  return last(texts.flatMap((t) => pattern.exec(t)?.[0] ?? []));
}

function nameIn(t: string): string | undefined {
  const stripped = t.replace(EMAIL, " ").replace(POSTCODE, " ").replace(JOB_REFERENCE, " ");
  for (const run of stripped.match(/[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)+/g) ?? []) {
    const words = run.split(/\s+/);
    while (words.length > 0 && NOT_NAME_WORDS.has(words[0]!.toLowerCase())) words.shift();
    if (words.length >= 2) return words.slice(0, 3).join(" ");
  }
  return undefined;
}

function issueTypeIn(t: string): IssueType | undefined {
  const s = t.toLowerCase();
  const exact = ISSUE_TYPES.find((i) => s.includes(i.toLowerCase()));
  if (exact) return exact;
  if (/heat\s*pump/.test(s)) return "Heat Pump";
  if (/\b(ac|a\/c|air[- ]?con\w*)\b/.test(s)) return "AC Repair & Install";
  if (/radiator/.test(s)) return "Radiators & Heating";
  if (/(repair|broken|fault|not working|breakdown|no heating|no hot water)/.test(s) && /(boiler|heating|hot water)/.test(s)) {
    return "Boiler Repair";
  }
  if (/(service|servicing|annual)/.test(s) && /boiler/.test(s)) return "Boiler Service";
  return undefined;
}

interface Details {
  jobReference?: string;
  fullName?: string;
  postcode?: string;
  email?: string;
  issueType?: IssueType;
}

/** The latest value the Customer gave for each detail, across the whole conversation. */
function detailsFrom(texts: string[]): Details {
  return {
    jobReference: lastMatch(texts, JOB_REFERENCE),
    postcode: lastMatch(texts, POSTCODE),
    email: lastMatch(texts, EMAIL),
    fullName: last(texts.map(nameIn).filter((n): n is string => !!n)),
    issueType: last(texts.map(issueTypeIn).filter((i): i is IssueType => !!i)),
  };
}

// ---------------------------------------------------------------------------
// Intents

const COMPLAINT = /\b(refund|compensation|discount|complain\w*|unacceptable|disgrace|angry|furious|not happy|unhappy|terrible)\b/i;
const PRICE = /(\bprices?\b|\bcosts?\b|how much|£|\bcharge[sd]?\b|\brates?\b)/i;
const LOOKUP = /(\bparts?\b|\bjob\b|\bvisit\b|\bstatus\b|where'?s|\bengineer\b|\bAPX-?\d+|reschedule|cancel|\bmy booking\b)/i;
const BOOKING = /(\bbook\w*|appointment|availab\w*|\bslots?\b|\bservice\b|\brepair\b|\binstall\w*|\bquote\b|\bbroken\b|heat pump)/i;
const YES = /\b(yes|yeah|yep|yup|confirm\w*|go ahead|sure|ok|okay|please do|that'?s right|correct|works for me)\b/i;
const NO = /\b(no|nope|don'?t|do not|cancel|stop|not now|wrong)\b/i;

/** The latest Customer message that names a topic decides the flow; Job lookups beat requests to book. */
function currentFlow(texts: string[]): "lookup" | "booking" | undefined {
  for (const t of [...texts].reverse()) {
    if (LOOKUP.test(t)) return "lookup";
    if (BOOKING.test(t)) return "booking";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Routing

/** The reply to the "You're welcome" kind of message once the Customer's business is done. */
const ANYTHING_ELSE_REPLY = "You're welcome! Is there anything else I can help with?";

function route(ctx: RequestContext): ModelResponse {
  const { messages, runs } = ctx;
  const lastMessage = messages.at(-1)!;
  const turnStart = messages.findLastIndex(isCustomerMessage);
  const thisTurn = runs.filter((r) => r.at > turnStart);
  // The last message is tool results: say what happened. Otherwise a Customer turn is starting.
  if (lastMessage.role === "user" && typeof lastMessage.content !== "string" && thisTurn.length > 0) {
    return afterTool(last(thisTurn)!, ctx);
  }
  return startTurn(ctx);
}

function startTurn(ctx: RequestContext): ModelResponse {
  const { texts, latestText: now, runs } = ctx;

  // 1. A proposal is waiting for the Customer's answer.
  const pending = pendingProposal(runs);
  if (pending && YES.test(now) && !NO.test(now)) {
    return reply([text("Great, confirming that now."), toolCall("confirm_action", { pendingActionId: pending.data.pendingActionId })]);
  }
  if (pending && NO.test(now) && !YES.test(now)) {
    return reply([text("No problem, I haven't booked anything. Tell me what you'd like to change, or ask for other times.")]);
  }

  // 2. Complaints and requests Apex can't grant go to a person.
  if (COMPLAINT.test(now)) {
    const reason = /(refund|compensation|discount)/i.test(now) ? "Out of Policy" : "Complaint";
    return reply([
      toolCall("create_handoff_ticket", {
        reason,
        summary: `Customer said: ${now.slice(0, 200)}`,
        recommendedNextStep: "Call the Customer, listen to the problem and agree the next step.",
      }),
    ]);
  }

  // 3. Price List questions.
  if (PRICE.test(now)) return reply([text(priceAnswer(now))]);

  const flow = currentFlow(texts);
  if (flow === "lookup") return lookup(ctx);
  if (flow === "booking") return booking(ctx);

  return reply([
    text(
      "Hi, I'm Apex (scripted dev mode). I can quote prices, check Availability and book a Visit, or look up one of your Jobs. What would you like to do?",
    ),
  ]);
}

/** The latest proposal not yet confirmed or superseded by a later one. */
function pendingProposal(runs: ToolRun[]): ToolRun | undefined {
  const proposal = last(runs.filter((r) => r.ok && r.data.pendingActionId));
  if (!proposal) return undefined;
  const confirmed = runs.some(
    (r) => r.name === "confirm_action" && r.at > proposal.at && r.input.pendingActionId === proposal.data.pendingActionId,
  );
  return confirmed ? undefined : proposal;
}

function priceAnswer(question: string): string {
  const q = question.toLowerCase();
  const item = (name: string) => PRICE_LIST.find((p) => p.item === name)!;
  const line = (name: string) => `${item(name).item}: ${item(name).price}`;
  if (/(\bac\b|air[- ]?con)/.test(q)) return `${line("AC service")}.`;
  if (/heat\s*pump/.test(q)) return `${line("Heat pump survey")}.`;
  if (/service/.test(q)) return `${line("Annual boiler service")}.`;
  if (/(repair|labour|fix)/.test(q)) return `${line("Boiler repair labour")}. ${line("Call-out & diagnosis")}.`;
  return `Our prices: ${PRICE_LIST.map((p) => `${p.item} ${p.price}`).join("; ")}.`;
}

// --- Verification and Job lookup -------------------------------------------

function lookup(ctx: RequestContext): ModelResponse {
  const { latestText: now, details, runs } = ctx;
  const verification = last(runs.filter((r) => r.name === "verify_customer" && r.ok && r.data.verified === true));
  const givesDetails = !!(JOB_REFERENCE.test(now) || POSTCODE.test(now) || EMAIL.test(now));
  if (verification && !LOOKUP.test(now) && !givesDetails) {
    return reply([text(ANYTHING_ELSE_REPLY)]);
  }
  if (verification) {
    const jobs: { jobReference: string; jobStatus: string; description: string }[] = verification.data.jobs ?? [];
    const named = JOB_REFERENCE.exec(now)?.[0]?.toUpperCase();
    const chosen =
      jobs.find((j) => j.jobReference === named)?.jobReference ??
      (/\bparts?\b/i.test(now) && jobs.filter((j) => j.jobStatus === "Awaiting Parts").length === 1
        ? jobs.find((j) => j.jobStatus === "Awaiting Parts")!.jobReference
        : undefined) ??
      verification.data.selectedJobReference ??
      (jobs.length === 1 ? jobs[0]!.jobReference : undefined);
    if (chosen) return reply([toolCall("get_job_details", { jobReference: chosen })]);
    return reply([text(`Thanks ${firstName(verification.data.customerName)}. Which Job do you mean? ${jobList(jobs)}`)]);
  }

  const jobReference = details.jobReference;
  const byJobReference = jobReference && (details.postcode || details.email);
  const byNameAndContact = details.fullName && details.postcode && details.email;
  if ((byJobReference || byNameAndContact) && givesDetails) {
    return reply([
      toolCall("verify_customer", {
        jobReference: byJobReference ? jobReference : null,
        fullName: byJobReference ? null : details.fullName,
        postcode: details.postcode ?? null,
        email: details.email ?? null,
      }),
    ]);
  }
  return reply([
    text(
      "I can look that up, but first I need to check it's you. Please give me your Job Reference with your postcode or email, or your full name, postcode and email.",
    ),
  ]);
}

const firstName = (name: unknown) => (typeof name === "string" ? name.split(" ")[0] : "there");
const jobList = (jobs: { jobReference: string; description: string }[]) =>
  jobs.map((j) => `${j.jobReference} (${j.description})`).join("; ");

// --- Availability and Jobs -------------------------------------------------

/** One Time Window the Agent offered, as `get_availability` returns it. */
interface OfferedWindow {
  date: string;
  timeWindow: string;
  label: string;
}

function booking(ctx: RequestContext): ModelResponse {
  const { messages, latestText: now, details, runs } = ctx;
  if (!details.issueType) {
    return reply([text("Happy to help. Which service do you need: Boiler Service, Boiler Repair, Radiators & Heating, AC Repair & Install or Heat Pump?")]);
  }
  if (!details.postcode) {
    return reply([text(`Great, ${details.issueType}. What's your full postcode, so I can check we cover you and find times?`)]);
  }

  const availability = last(runs.filter((r) => r.name === "get_availability" && r.ok && Array.isArray(r.data.windows)));
  const fromDate = ISO_DATE.exec(now)?.[0] ?? null;
  const comparablePostcode = (v: unknown) => String(v).replace(/\s+/g, "").toLowerCase();
  const changedSearch =
    !!availability &&
    (availability.input.issueType !== details.issueType ||
      comparablePostcode(availability.input.postcode) !== comparablePostcode(details.postcode) ||
      (fromDate !== null && availability.input.fromDate !== fromDate));
  // A confirmed Job ends that search: only a new request to book starts another.
  const bookedSince = !!availability && runs.some((r) => r.name === "confirm_action" && r.ok && r.at > availability.at);
  if (bookedSince && !BOOKING.test(now)) return reply([text(ANYTHING_ELSE_REPLY)]);
  if (!availability || changedSearch || bookedSince) {
    return reply([toolCall("get_availability", { issueType: details.issueType, postcode: details.postcode, fromDate })]);
  }

  const windows: OfferedWindow[] = availability.data.windows;
  if (windows.length === 0) return reply([text("I couldn't find any Availability in the next two weeks. I can pass this to the team if you like.")]);

  // Look for the Customer's pick in what they have said since the Time Windows were offered.
  const since = messages.slice(availability.at).filter(isCustomerMessage).map((m) => m.content as string);
  const pick = last(since.map((t) => pickWindow(t, windows)).filter((w): w is OfferedWindow => !!w));
  const missing = [details.fullName ? "" : "full name", details.email ? "" : "email address"].filter(Boolean);

  if (!pick) return reply([text(`${listOfferedWindows(details.issueType, windows)} Which would you like?${missing.length ? ` I'll also need your ${missing.join(" and ")}.` : ""}`)]);
  if (missing.length) return reply([text(`${pick.label} it is. To book it I need your ${missing.join(" and ")}.`)]);
  return reply([
    toolCall("propose_booking", {
      fullName: details.fullName,
      postcode: details.postcode,
      email: details.email,
      issueType: details.issueType,
      date: pick.date,
      timeWindow: pick.timeWindow,
    }),
  ]);
}

const listOfferedWindows = (issueType: string, windows: { label: string }[]) =>
  `The earliest times for ${issueType}: ${windows.map((w, i) => `${i + 1}) ${w.label}`).join("; ")}.`;

/** Ordinal words and the index they name in the offered windows (-1 counts from the end). */
const ORDINAL_WORD_INDEX: Record<string, number> = {
  first: 0,
  "1st": 0,
  earliest: 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  last: -1,
};

/** Which offered window the Customer chose: by ordinal, date, AM/PM or a plain yes. */
function pickWindow(t: string, windows: OfferedWindow[]): OfferedWindow | undefined {
  const s = t.replace(EMAIL, " ").replace(POSTCODE, " ");
  const ordinal = /(?:^\s*|\b(?:option|number|slot|no\.?)\s*)([123])\s*[.)]?\s*$|\b(first|1st|earliest|second|2nd|third|3rd|last)\b/i.exec(s);
  const word = ordinal?.[2]?.toLowerCase();
  const index = ordinal?.[1] ? Number(ordinal[1]) - 1 : word ? ORDINAL_WORD_INDEX[word] : undefined;
  if (index !== undefined) return windows.at(index);
  const iso = ISO_DATE.exec(s)?.[0];
  const sameDay = iso ? windows.filter((w) => w.date === iso) : windows;
  const half = /\b(am|morning)\b/i.test(s) ? "AM" : /\b(pm|afternoon)\b/i.test(s) ? "PM" : undefined;
  if (iso || half) return sameDay.find((w) => !half || w.timeWindow === half);
  const weekday = windows.find((w) => new RegExp(`\\b${w.label.split(/[ ,]/)[0]}\\b`, "i").test(s));
  if (weekday) return weekday;
  return YES.test(s) && !NO.test(s) ? windows[0] : undefined;
}

// ---------------------------------------------------------------------------
// After a tool ran: tell the Customer what happened

function afterTool(run: ToolRun, ctx: RequestContext): ModelResponse {
  const { data } = run;
  if (!run.ok) return reply([text(`Sorry, I couldn't do that: ${String(data.error ?? "something went wrong")}`)]);

  switch (run.name) {
    case "get_availability":
      // Offering the Time Windows (and asking for what is missing) is the same as the router's next step.
      return booking(ctx);
    case "propose_booking": {
      const b = data.readBack;
      return reply([
        text(`Just to check before I book: ${b.issueType} at ${b.postcode} on ${b.label}, for ${b.fullName} (${b.email}). Shall I go ahead?`),
      ]);
    }
    case "confirm_action":
      return reply([
        text(
          data.booked
            ? `You're booked. Your Job Reference is ${data.jobReference}: ${data.issueType} on ${data.label}.`
            : "That's done.",
        ),
      ]);
    case "verify_customer":
      if (data.verified) return lookup(ctx);
      return reply([
        text(
          data.locked
            ? "I'm sorry, I can't verify you after several attempts. I'll pass this to the Apex team."
            : `Those details didn't match our records. Please check them and try again (${data.attemptsRemaining} attempts left).`,
        ),
      ]);
    case "get_job_details":
      return reply([text(describeJob(data))]);
    case "create_handoff_ticket":
      return reply([
        text(`I'm sorry about that. I've passed this to the Apex team (Handoff Ticket ${data.ticketReference}) and someone will follow up with you.`),
      ]);
    default:
      return reply([text("Done.")]);
  }
}

function describeJob(job: Record<string, any>): string {
  const parts: { partName: string; partsStatus: string; expectedArrival: string }[] = job.partsOrders ?? [];
  const visits: { date: string; timeWindow: string; engineerFirstName: string }[] = job.upcomingVisits ?? [];
  return [
    `${job.jobReference} (${job.description}) is ${job.jobStatus}.`,
    ...parts.map((p) => `Part: ${p.partName}, ${p.partsStatus}, expected ${p.expectedArrival}.`),
    ...visits.map((v) => `Next Visit: ${v.date} ${v.timeWindow} with ${v.engineerFirstName}.`),
  ].join(" ");
}
