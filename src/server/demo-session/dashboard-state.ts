import {
  addDays,
  isWeekday,
  londonDateOf,
  mondayOf,
  type PlainDate,
} from "@/domain/london-time";
import type { TimeWindow } from "@/domain/time-window";
import {
  URGENCIES,
  type EscalationReason,
  type HandoffTicketStatus,
  type IssueType,
  type JobStatus,
  type PartsStatus,
  type Urgency,
} from "@/domain/vocabulary";
import { readAgentTrace, type AgentTraceEntry } from "@/server/agent/conversation-store";
import type { Database } from "@/server/db/database";

export interface DashboardEngineer {
  id: string;
  name: string;
  skills: IssueType[];
}

export interface DashboardCustomer {
  fullName: string;
  postcode: string;
  email: string;
}

export interface DashboardVisit {
  id: string;
  date: PlainDate;
  timeWindow: TimeWindow;
  engineer: { id: string; name: string };
  isEmergencyVisit: boolean;
}

export interface DashboardJob {
  id: string;
  jobReference: string;
  issueType: IssueType;
  description: string;
  jobStatus: JobStatus;
  createdAt: string;
  customer: DashboardCustomer;
  /** All of the Job's Visits, earliest first. */
  visits: DashboardVisit[];
}

export interface CalendarDay {
  date: PlainDate;
  isToday: boolean;
}

/** A Visit as placed on the calendar grid (Engineer × day × Time Window). */
export interface CalendarVisit {
  visitId: string;
  date: PlainDate;
  timeWindow: TimeWindow;
  engineerId: string;
  jobReference: string;
  issueType: IssueType;
  jobStatus: JobStatus;
  customerName: string;
  postcode: string;
  isEmergencyVisit: boolean;
}

/** Everything the Operations Dashboard shows for one Demo Session. JSON-safe. */
export interface DashboardState {
  sessionId: string;
  calendar: {
    /** The weekdays of this week and next (from the coming Monday at a weekend). */
    days: CalendarDay[];
    engineers: DashboardEngineer[];
    visits: CalendarVisit[];
  };
  /** Newest Job Reference first. */
  jobs: DashboardJob[];
  /** Soonest expected arrival first. */
  partsOrders: DashboardPartsOrder[];
  /** The queue: most urgent first, then oldest first. */
  handoffTickets: DashboardHandoffTicket[];
  /** Customers whose details the "Try a scenario" tray shows visitors. */
  demoCustomers: DemoCustomer[];
  /** Every tool the Agent called in this Demo Session (and refusals/errors), oldest first. */
  agentTrace: AgentTraceEntry[];
  /** New Customers whose email matched an existing one but not the name or postcode; oldest first. */
  possibleDuplicateCustomers: PossibleDuplicateCustomer[];
}

/** A Customer flagged for an Operator to check and merge into `possibleDuplicateOf`. */
export interface PossibleDuplicateCustomer {
  customer: DashboardCustomer;
  jobReferences: string[];
  possibleDuplicateOf: DashboardCustomer & { jobReferences: string[] };
}

export interface DemoCustomer extends DashboardCustomer {
  phone: string | null;
  jobReferences: string[];
}

export interface DashboardHandoffTicket {
  id: string;
  /** e.g. "APX-H-0001". */
  ticketReference: string;
  escalationReason: EscalationReason;
  urgency: Urgency;
  status: HandoffTicketStatus;
  summary: string;
  recommendedNextStep: string;
  createdAt: string;
  customer: DashboardCustomer | null;
  jobReference: string | null;
  /** The conversation it was raised from; null for seed tickets. */
  conversationId: string | null;
  /** What was added to the ticket, oldest first (empty for seed tickets). */
  timeline: HandoffTicketEvent[];
}

export interface HandoffTicketEvent {
  /** created/appended by escalations; acknowledged/resolved by an Operator. */
  kind: "created" | "appended" | "acknowledged" | "resolved";
  text: string;
  at: string;
}

export interface DashboardPartsOrder {
  id: string;
  jobReference: string;
  partName: string;
  partsStatus: PartsStatus;
  /** Expected arrival, or actual arrival once Arrived/Fitted. */
  expectedArrival: PlainDate;
  customerName: string;
}

export async function readDashboardState(
  db: Database,
  sessionId: string,
  now: Date,
): Promise<DashboardState> {
  const engineers = await db.query<DashboardEngineer>(
    "SELECT id, name, skills FROM engineer WHERE session_id = $1 ORDER BY sort_order",
    [sessionId],
  );

  const jobs = await db.query<{
    id: string;
    job_reference: string;
    issue_type: IssueType;
    description: string;
    job_status: JobStatus;
    created_at: Date;
    full_name: string;
    postcode: string;
    email: string;
  }>(
    `SELECT j.id, j.job_reference, j.issue_type, j.description, j.job_status, j.created_at,
            c.full_name, c.postcode, c.email
       FROM job j
       JOIN customer c ON c.id = j.customer_id AND c.session_id = j.session_id
      WHERE j.session_id = $1
      ORDER BY j.job_reference DESC`,
    [sessionId],
  );

  const visits = await db.query<{
    id: string;
    job_id: string;
    visit_date: PlainDate;
    time_window: TimeWindow;
    engineer_id: string;
    engineer_name: string;
    is_emergency_visit: boolean;
  }>(
    `SELECT v.id, v.job_id, v.visit_date::text AS visit_date, v.time_window,
            v.engineer_id, e.name AS engineer_name, v.is_emergency_visit
       FROM visit v
       JOIN engineer e ON e.id = v.engineer_id AND e.session_id = v.session_id
      WHERE v.session_id = $1
      ORDER BY v.visit_date, v.time_window, e.sort_order`,
    [sessionId],
  );
  const visitsByJob = new Map<string, DashboardVisit[]>();
  for (const v of visits.rows) {
    const list = visitsByJob.get(v.job_id) ?? [];
    list.push({
      id: v.id,
      date: v.visit_date,
      timeWindow: v.time_window,
      engineer: { id: v.engineer_id, name: v.engineer_name },
      isEmergencyVisit: v.is_emergency_visit,
    });
    visitsByJob.set(v.job_id, list);
  }

  const dashboardJobs: DashboardJob[] = jobs.rows.map((r) => ({
    id: r.id,
    jobReference: r.job_reference,
    issueType: r.issue_type,
    description: r.description,
    jobStatus: r.job_status,
    createdAt: r.created_at.toISOString(),
    customer: { fullName: r.full_name, postcode: r.postcode, email: r.email },
    visits: visitsByJob.get(r.id) ?? [],
  }));

  const days = calendarDays(londonDateOf(now));
  const shownDates = new Set(days.map((d) => d.date));
  const calendarVisits: CalendarVisit[] = dashboardJobs.flatMap((job) =>
    job.visits
      .filter((v) => shownDates.has(v.date))
      .map((v) => ({
        visitId: v.id,
        date: v.date,
        timeWindow: v.timeWindow,
        engineerId: v.engineer.id,
        jobReference: job.jobReference,
        issueType: job.issueType,
        jobStatus: job.jobStatus,
        customerName: job.customer.fullName,
        postcode: job.customer.postcode,
        isEmergencyVisit: v.isEmergencyVisit,
      })),
  );

  const partsOrders = await db.query<DashboardPartsOrder>(
    `SELECT p.id, j.job_reference AS "jobReference", p.part_name AS "partName",
            p.parts_status AS "partsStatus", p.expected_arrival::text AS "expectedArrival",
            c.full_name AS "customerName"
       FROM parts_order p
       JOIN job j ON j.id = p.job_id AND j.session_id = p.session_id
       JOIN customer c ON c.id = j.customer_id AND c.session_id = j.session_id
      WHERE p.session_id = $1
      ORDER BY p.expected_arrival, j.job_reference`,
    [sessionId],
  );

  const tickets = await db.query<{
    id: string;
    ticket_number: number;
    escalation_reason: EscalationReason;
    urgency: Urgency;
    status: HandoffTicketStatus;
    summary: string;
    recommended_next_step: string;
    created_at: Date;
    full_name: string | null;
    postcode: string | null;
    email: string | null;
    job_reference: string | null;
    conversation_id: string | null;
  }>(
    `SELECT t.id, t.ticket_number, t.escalation_reason, t.urgency, t.status, t.summary,
            t.recommended_next_step, t.created_at, t.conversation_id,
            c.full_name, c.postcode, c.email, j.job_reference
       FROM handoff_ticket t
       LEFT JOIN customer c ON c.id = t.customer_id AND c.session_id = t.session_id
       LEFT JOIN job j ON j.id = t.job_id AND j.session_id = t.session_id
      WHERE t.session_id = $1
      ORDER BY array_position($2::text[], t.urgency), t.created_at, t.ticket_number`,
    [sessionId, URGENCIES],
  );

  const ticketEvents = await db.query<{
    ticket_id: string;
    kind: HandoffTicketEvent["kind"];
    text: string;
    created_at: Date;
  }>(
    `SELECT ticket_id, kind, text, created_at FROM handoff_ticket_event
      WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  const timelines = new Map<string, HandoffTicketEvent[]>();
  for (const e of ticketEvents.rows) {
    const list = timelines.get(e.ticket_id) ?? [];
    list.push({ kind: e.kind, text: e.text, at: e.created_at.toISOString() });
    timelines.set(e.ticket_id, list);
  }

  const demoCustomers = await db.query<DemoCustomer>(
    `SELECT c.full_name AS "fullName", c.postcode, c.email, c.phone,
            array_agg(j.job_reference ORDER BY j.job_reference) AS "jobReferences"
       FROM customer c
       JOIN job j ON j.customer_id = c.id AND j.session_id = c.session_id
      WHERE c.session_id = $1 AND c.demo_friendly
      GROUP BY c.id
      ORDER BY c.full_name`,
    [sessionId],
  );

  const agentTrace = await readAgentTrace(db, sessionId);
  const possibleDuplicateCustomers = await readPossibleDuplicateCustomers(db, sessionId);

  return {
    sessionId,
    agentTrace,
    possibleDuplicateCustomers,
    demoCustomers: demoCustomers.rows,
    calendar: { days, engineers: engineers.rows, visits: calendarVisits },
    jobs: dashboardJobs,
    partsOrders: partsOrders.rows,
    handoffTickets: tickets.rows.map((t) => ({
      id: t.id,
      ticketReference: handoffTicketReference(t.ticket_number),
      escalationReason: t.escalation_reason,
      urgency: t.urgency,
      status: t.status,
      summary: t.summary,
      recommendedNextStep: t.recommended_next_step,
      createdAt: t.created_at.toISOString(),
      customer:
        t.full_name && t.postcode && t.email
          ? { fullName: t.full_name, postcode: t.postcode, email: t.email }
          : null,
      jobReference: t.job_reference,
      conversationId: t.conversation_id,
      timeline: timelines.get(t.id) ?? [],
    })),
  };
}

async function readPossibleDuplicateCustomers(
  db: Database,
  sessionId: string,
): Promise<PossibleDuplicateCustomer[]> {
  const jobRefs = (alias: string) =>
    `COALESCE((SELECT array_agg(j.job_reference ORDER BY j.job_reference) FROM job j
                WHERE j.session_id = $1 AND j.customer_id = ${alias}.id), '{}')`;
  const { rows } = await db.query<{
    full_name: string;
    postcode: string;
    email: string;
    job_references: string[];
    of_full_name: string;
    of_postcode: string;
    of_email: string;
    of_job_references: string[];
  }>(
    `SELECT c.full_name, c.postcode, c.email, ${jobRefs("c")} AS job_references,
            o.full_name AS of_full_name, o.postcode AS of_postcode, o.email AS of_email,
            ${jobRefs("o")} AS of_job_references
       FROM customer c
       JOIN customer o ON o.id = c.possible_duplicate_of AND o.session_id = c.session_id
      WHERE c.session_id = $1
      ORDER BY c.created_at, c.id`,
    [sessionId],
  );
  return rows.map((r) => ({
    customer: { fullName: r.full_name, postcode: r.postcode, email: r.email },
    jobReferences: r.job_references,
    possibleDuplicateOf: {
      fullName: r.of_full_name,
      postcode: r.of_postcode,
      email: r.of_email,
      jobReferences: r.of_job_references,
    },
  }));
}

/** The Operator-facing Handoff Ticket reference, numbered per Demo Session. */
export function handoffTicketReference(ticketNumber: number): string {
  return `APX-H-${String(ticketNumber).padStart(4, "0")}`;
}

function calendarDays(today: PlainDate): CalendarDay[] {
  const monday = isWeekday(today) ? mondayOf(today) : addDays(mondayOf(today), 7);
  return [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map((offset) => {
    const date = addDays(monday, offset);
    return { date, isToday: date === today };
  });
}
