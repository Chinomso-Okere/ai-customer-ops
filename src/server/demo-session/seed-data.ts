/**
 * The fixed Apex seed world. Dates are expressed relative to the Demo Session's
 * creation day so every session looks like a live business this week
 * (ADR-0001). The same data seeds every session, so Job References and
 * demo-friendly Customers are stable across sessions.
 */
import type { TimeWindow } from "@/domain/time-window";
import type {
  EscalationReason,
  IssueType,
  JobStatus,
  PartsStatus,
  Urgency,
} from "@/domain/vocabulary";

export interface EngineerSeed {
  name: string;
  skills: IssueType[];
}

/** 5 Engineers with overlapping skills; every Issue Type has 2+ Engineers. */
export const ENGINEERS: EngineerSeed[] = [
  { name: "Dave Okafor", skills: ["Boiler Repair", "Boiler Service", "Radiators & Heating"] },
  { name: "Priya Shah", skills: ["Boiler Service", "Radiators & Heating", "Heat Pump"] },
  { name: "Tom Whitaker", skills: ["AC Repair & Install", "Heat Pump"] },
  { name: "Marta Kowalski", skills: ["Boiler Repair", "Boiler Service", "AC Repair & Install"] },
  { name: "Leon Grant", skills: ["Boiler Repair", "Radiators & Heating", "Heat Pump"] },
];

export interface CustomerSeed {
  fullName: string;
  postcode: string;
  email: string;
  phone: string | null;
  /** Surfaced in the "Try a scenario" tray so visitors can try Verification. */
  demoFriendly?: true;
}

// Emails use example.com and phones the Ofcom drama range: none are real.
export const CUSTOMERS: CustomerSeed[] = [
  { fullName: "Sarah Mitchell", postcode: "SW4 7AB", email: "sarah.mitchell@example.com", phone: "07700 900101", demoFriendly: true },
  { fullName: "James Patel", postcode: "SE15 4QF", email: "james.patel@example.com", phone: "07700 900102", demoFriendly: true },
  { fullName: "Emma Clarke", postcode: "SW11 2PL", email: "emma.clarke@example.com", phone: null, demoFriendly: true },
  { fullName: "Oliver Bennett", postcode: "SW2 1HG", email: "oliver.bennett@example.com", phone: "07700 900104" },
  { fullName: "Amelia Hughes", postcode: "SW8 2LT", email: "amelia.hughes@example.com", phone: null },
  { fullName: "George Adeyemi", postcode: "SW9 9QP", email: "george.adeyemi@example.com", phone: "07700 900106" },
  { fullName: "Isla Thompson", postcode: "SW12 8NR", email: "isla.thompson@example.com", phone: "07700 900107" },
  { fullName: "Harry Robinson", postcode: "SE5 7DJ", email: "harry.robinson@example.com", phone: null },
  { fullName: "Mia Wright", postcode: "SE11 4BB", email: "mia.wright@example.com", phone: "07700 900109" },
  { fullName: "Noah Edwards", postcode: "SE22 8HU", email: "noah.edwards@example.com", phone: "07700 900110" },
  { fullName: "Ava Lewis", postcode: "SW4 0JE", email: "ava.lewis@example.com", phone: null },
  { fullName: "Jack Walker", postcode: "SW11 5RN", email: "jack.walker@example.com", phone: "07700 900112" },
  { fullName: "Sophia Green", postcode: "SE15 3AF", email: "sophia.green@example.com", phone: "07700 900113" },
  { fullName: "Charlie Hall", postcode: "SW2 5TR", email: "charlie.hall@example.com", phone: null },
  { fullName: "Grace Allen", postcode: "SW8 1UQ", email: "grace.allen@example.com", phone: "07700 900115" },
  { fullName: "Freddie Young", postcode: "SW9 7EH", email: "freddie.young@example.com", phone: "07700 900116" },
  { fullName: "Lily King", postcode: "SW12 9AW", email: "lily.king@example.com", phone: null },
  { fullName: "Alfie Scott", postcode: "SE5 8RS", email: "alfie.scott@example.com", phone: "07700 900118" },
  { fullName: "Ella Baker", postcode: "SE11 5JD", email: "ella.baker@example.com", phone: "07700 900119" },
  { fullName: "Arthur Nelson", postcode: "SE22 9EX", email: "arthur.nelson@example.com", phone: null },
  { fullName: "Chloe Carter", postcode: "SW4 9DL", email: "chloe.carter@example.com", phone: "07700 900121" },
  { fullName: "Oscar Mensah", postcode: "SE15 5NH", email: "oscar.mensah@example.com", phone: "07700 900122" },
  { fullName: "Ruby Campbell", postcode: "SW11 1QT", email: "ruby.campbell@example.com", phone: null },
  { fullName: "Theo Evans", postcode: "SE5 0HB", email: "theo.evans@example.com", phone: "07700 900124" },
  { fullName: "Zara Hussain", postcode: "SW9 8PL", email: "zara.hussain@example.com", phone: "07700 900125" },
];

/**
 * A Visit as [weekday offset from the session's creation day, Time Window].
 * Offset 0 is today (or, at a weekend, the previous Friday). Offsets stay
 * within −20…+10 weekdays, i.e. inside −30…+14 calendar days.
 */
export type VisitSeed = readonly [weekdayOffset: number, timeWindow: TimeWindow];

export interface PartsOrderSeed {
  partName: string;
  partsStatus: PartsStatus;
  /** Expected (or actual) arrival, as calendar days from the creation day. */
  arrivalDayOffset: number;
}

export interface JobSeed {
  /** Index into CUSTOMERS. */
  customer: number;
  issueType: IssueType;
  jobStatus: JobStatus;
  description: string;
  visits: readonly VisitSeed[];
  partsOrder?: PartsOrderSeed;
  /** For Jobs without Visits: how many days before creation the Job was raised. */
  raisedDaysAgo?: number;
}

const SARAH = 0;
const JAMES = 1;
const EMMA = 2;

export const JOBS: JobSeed[] = [
  // Completed
  { customer: 3, issueType: "Boiler Service", jobStatus: "Completed", description: "Annual boiler service", visits: [[-20, "AM"]] },
  { customer: 4, issueType: "Heat Pump", jobStatus: "Completed", description: "Heat pump survey", visits: [[-19, "PM"]] },
  { customer: 5, issueType: "Boiler Repair", jobStatus: "Completed", description: "No hot water; thermocouple replaced", visits: [[-17, "AM"]] },
  { customer: 6, issueType: "Radiators & Heating", jobStatus: "Completed", description: "Cold radiators upstairs; system bled", visits: [[-15, "PM"]] },
  { customer: 7, issueType: "AC Repair & Install", jobStatus: "Completed", description: "Split AC unit installed in home office", visits: [[-14, "AM"], [-14, "PM"]] },
  { customer: 8, issueType: "Heat Pump", jobStatus: "Completed", description: "Air source heat pump install", visits: [[-12, "AM"], [-12, "PM"], [-11, "AM"], [-11, "PM"]] },
  {
    customer: 10, issueType: "Boiler Repair", jobStatus: "Completed", description: "Boiler losing pressure; expansion vessel replaced",
    visits: [[-9, "AM"], [-6, "PM"]],
    partsOrder: { partName: "Expansion vessel", partsStatus: "Fitted", arrivalDayOffset: -9 },
  },
  { customer: EMMA, issueType: "Boiler Service", jobStatus: "Completed", description: "Annual boiler service", visits: [[-8, "AM"]] },
  { customer: 11, issueType: "Radiators & Heating", jobStatus: "Completed", description: "Two living-room radiators replaced", visits: [[-7, "PM"]] },
  { customer: 13, issueType: "AC Repair & Install", jobStatus: "Completed", description: "AC unit not cooling; regassed", visits: [[-3, "PM"]] },
  { customer: 14, issueType: "Boiler Repair", jobStatus: "Completed", description: "Banging noise from boiler; pump replaced", visits: [[-1, "AM"]] },

  // Cancelled
  { customer: 15, issueType: "Boiler Service", jobStatus: "Cancelled", description: "Annual boiler service (Customer moved house)", visits: [], raisedDaysAgo: 12 },
  { customer: 16, issueType: "AC Repair & Install", jobStatus: "Cancelled", description: "AC install quote", visits: [], raisedDaysAgo: 6 },

  // In Progress
  { customer: 18, issueType: "Heat Pump", jobStatus: "In Progress", description: "Air source heat pump install", visits: [[0, "AM"], [0, "PM"], [1, "AM"], [1, "PM"]] },
  { customer: 19, issueType: "AC Repair & Install", jobStatus: "In Progress", description: "Multi-split AC install", visits: [[0, "PM"], [1, "AM"]] },
  { customer: 20, issueType: "Radiators & Heating", jobStatus: "In Progress", description: "Powerflush and radiator replacement", visits: [[0, "AM"], [2, "AM"]] },
  {
    customer: 21, issueType: "Boiler Repair", jobStatus: "In Progress", description: "Intermittent ignition fault",
    visits: [[-1, "PM"], [0, "PM"]],
    partsOrder: { partName: "Ignition electrode", partsStatus: "Fitted", arrivalDayOffset: -1 },
  },

  // Awaiting Parts
  {
    customer: SARAH, issueType: "Boiler Repair", jobStatus: "Awaiting Parts", description: "No heating; faulty diverter valve",
    visits: [[-3, "PM"]],
    partsOrder: { partName: "Diverter valve", partsStatus: "Dispatched", arrivalDayOffset: 1 },
  },
  {
    customer: EMMA, issueType: "Boiler Repair", jobStatus: "Awaiting Parts", description: "Fault code F28; boiler PCB needs replacing",
    visits: [[-6, "AM"]],
    partsOrder: { partName: "Boiler PCB", partsStatus: "Arrived", arrivalDayOffset: -1 },
  },
  {
    customer: 22, issueType: "AC Repair & Install", jobStatus: "Awaiting Parts", description: "AC compressor failure",
    visits: [[-4, "AM"]],
    partsOrder: { partName: "AC compressor", partsStatus: "Ordered", arrivalDayOffset: 7 },
  },
  {
    customer: 23, issueType: "Boiler Repair", jobStatus: "Awaiting Parts", description: "Fan fault; boiler locking out",
    visits: [[-2, "PM"]],
    partsOrder: { partName: "Fan assembly", partsStatus: "Ordered", arrivalDayOffset: 4 },
  },

  // Scheduled
  { customer: JAMES, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[3, "AM"]] },
  { customer: 24, issueType: "Heat Pump", jobStatus: "Scheduled", description: "Air source heat pump install", visits: [[2, "AM"], [2, "PM"], [3, "AM"], [3, "PM"]] },
  { customer: 3, issueType: "Radiators & Heating", jobStatus: "Scheduled", description: "Bedroom radiator not heating", visits: [[1, "PM"]] },
  { customer: 4, issueType: "Heat Pump", jobStatus: "Scheduled", description: "Air source heat pump install", visits: [[6, "AM"], [6, "PM"], [7, "AM"], [7, "PM"]] },
  { customer: 5, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[1, "AM"]] },
  { customer: 6, issueType: "AC Repair & Install", jobStatus: "Scheduled", description: "AC install in two bedrooms", visits: [[4, "AM"], [4, "PM"]] },
  { customer: 7, issueType: "Boiler Repair", jobStatus: "Scheduled", description: "Replace failed combi boiler", visits: [[5, "AM"], [5, "PM"], [6, "AM"], [6, "PM"]] },
  { customer: 8, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[2, "PM"]] },
  { customer: 9, issueType: "Heat Pump", jobStatus: "Scheduled", description: "Ground source heat pump install", visits: [[8, "AM"], [8, "PM"], [9, "AM"], [9, "PM"]] },
  { customer: 10, issueType: "Radiators & Heating", jobStatus: "Scheduled", description: "Fit thermostatic radiator valves", visits: [[4, "PM"]] },
  { customer: 11, issueType: "AC Repair & Install", jobStatus: "Scheduled", description: "AC service and filter clean", visits: [[5, "PM"]] },
  { customer: 12, issueType: "Boiler Repair", jobStatus: "Scheduled", description: "Water leaking under boiler", visits: [[1, "PM"]] },
  { customer: 13, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[6, "AM"]] },
  { customer: 14, issueType: "Heat Pump", jobStatus: "Scheduled", description: "Heat pump annual check", visits: [[3, "PM"]] },
  { customer: 16, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[7, "PM"]] },
  { customer: 17, issueType: "Radiators & Heating", jobStatus: "Scheduled", description: "Move radiator for kitchen refit", visits: [[8, "AM"]] },
  { customer: 19, issueType: "Boiler Repair", jobStatus: "Scheduled", description: "Pilot light keeps going out", visits: [[9, "PM"]] },
  { customer: 20, issueType: "AC Repair & Install", jobStatus: "Scheduled", description: "AC unit making a rattling noise", visits: [[10, "AM"]] },
  { customer: 15, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[10, "PM"]] },
  { customer: 21, issueType: "Radiators & Heating", jobStatus: "Scheduled", description: "Radiator leaking at valve", visits: [[7, "AM"]] },
  { customer: 22, issueType: "Boiler Service", jobStatus: "Scheduled", description: "Annual boiler service", visits: [[2, "AM"]] },
  { customer: 23, issueType: "Radiators & Heating", jobStatus: "Scheduled", description: "Upgrade radiators to double panel", visits: [[4, "AM"], [8, "PM"], [9, "AM"]] },
  { customer: 18, issueType: "Boiler Repair", jobStatus: "Scheduled", description: "Boiler making a whistling noise", visits: [[6, "PM"]] },
];

export interface HandoffTicketSeed {
  /** Index into JOBS; the ticket is about that Job's Customer. */
  job: number;
  escalationReason: EscalationReason;
  urgency: Urgency;
  summary: string;
  recommendedNextStep: string;
  openedHoursAgo: number;
}

/** 2 already-open Handoff Tickets. */
export const HANDOFF_TICKETS: HandoffTicketSeed[] = [
  {
    job: 10,
    escalationReason: "Complaint",
    urgency: "High",
    summary:
      "Customer says the Engineer arrived two hours late for the recent boiler repair and left dust in the hallway.",
    recommendedNextStep: "Call the Customer to apologise and offer a goodwill check-up visit.",
    openedHoursAgo: 3,
  },
  {
    job: 19,
    escalationReason: "Out of Policy",
    urgency: "Normal",
    summary:
      "Customer asked for a discount because the AC compressor is taking over a week to arrive.",
    recommendedNextStep: "Review the discount request; the Agent cannot grant discounts.",
    openedHoursAgo: 26,
  },
];
