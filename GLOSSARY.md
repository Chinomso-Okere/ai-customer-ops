# Apex Heating & Cooling — Customer Operations

A fictional UK heating & cooling company whose customers are served by a booking and support agent, while staff watch jobs, visits and escalations on an operations dashboard.

## Demo

**Demo Session**:
A private, disposable copy of the seeded Apex world belonging to one visitor; resetting the demo means starting a new Demo Session.
_Avoid_: Sandbox, tenant, workspace

## People

**Customer**:
A person who owns or occupies a property Apex serves, identified by name, postcode and email.
_Avoid_: Client, user, account

**Engineer**:
An Apex field worker who attends Visits.
_Avoid_: Technician, tech, installer

**Operator**:
An Apex staff member who works the Operations Dashboard and handles Handoff Tickets.
_Avoid_: Agent (reserved for the AI), admin, rep

**Agent**:
The AI assistant that talks to Customers in the chat.
_Avoid_: Bot, chatbot, assistant

## Work

**Job**:
One unit of work for one Customer about one problem, from first contact to completion.
_Avoid_: Appointment, booking, ticket, order
_Exempt_: Identifiers the spec names (tool names such as `propose_booking`, pending-action kinds) keep their spec spelling; the _Avoid_ lists apply to prose, not to those identifiers.

**Job Reference**:
The customer-facing identifier of a Job, e.g. `APX-10482`.
_Avoid_: Job number, ticket ID, booking ref

**Visit**:
A scheduled time window on a Job when an assigned Engineer attends the property; a Job may have several.
_Avoid_: Appointment, slot (a slot is availability, not a Visit)

**Parts Order**:
A part ordered from a supplier for a specific Job.
_Avoid_: Order (alone), purchase

**Job Status**:
Where a Job is in its life: Scheduled, In Progress, Awaiting Parts, Completed, or Cancelled.

**Parts Status**:
Where a Parts Order is in its life: Ordered, Dispatched, Arrived, or Fitted.

**Issue Type**:
The category of problem a Job addresses (e.g. Boiler Repair, Boiler Service, Radiators & Heating, AC Repair & Install, Heat Pump); it decides which Engineers can attend.
_Avoid_: Service type, category, job type

## Scheduling

**Time Window**:
A half-day period in which a Visit takes place: AM (08:00–12:00) or PM (12:00–17:00), weekdays only.
_Avoid_: Slot, appointment time

**Availability**:
The Time Windows in which at least one suitably skilled Engineer is free.
_Avoid_: Free slots, openings

**Coverage Area**:
The set of outward postcodes Apex serves; Customers outside it cannot be booked.
_Avoid_: Service area, region, patch

**Emergency Visit**:
A Visit booked in response to an Emergency the company can act on (e.g. flooding); it may override a full calendar.
_Avoid_: Urgent appointment, priority booking

**Book** (verb):
To create a Job together with its first Visit. Rescheduling moves an existing Visit; it never creates a new Job.

**Price List**:
The published prices and FAQ answers the Agent may quote; any price not on it is Out of Policy.
_Avoid_: Rate card, tariff, knowledge base

**Confirmation**:
A Customer's clear agreement, in their own words, to a specific write action the Agent has just read back (book, reschedule, or cancel).
_Avoid_: Consent, approval

## Trust & escalation

**Verification**:
Proving a Customer's identity before the Agent reveals Job details: either Job Reference plus postcode or email, or full name plus postcode plus email.
_Avoid_: Login, authentication

**Escalation**:
The Agent stopping its own handling of a topic and passing it to an Operator.
_Avoid_: Transfer, handover

**Handoff Ticket**:
The structured record of an Escalation (Customer details, conversation summary, urgency, recommended next step) that Operators acknowledge and resolve.
_Avoid_: Ticket (alone), case, support request

**Escalation Reason**:
Why an Escalation happened: Emergency, Complaint, or Out of Policy. A conversation has at most one open Handoff Ticket per reason.

**Urgency**:
How fast an Operator must act on a Handoff Ticket: Critical, High, or Normal.
_Avoid_: Priority, severity

**Out of Policy**:
A request the Agent is not permitted to grant, such as a refund, discount, or price outside the published price list.

**Emergency**:
A situation that endangers people or property (e.g. a gas leak or flooding); it always triggers an Escalation and a Safety Script.

**Agent Trace**:
The live, Operator-visible record of each tool the Agent calls and what came back.
_Avoid_: Logs, debug output

**Safety Script**:
Fixed, pre-written safety instructions shown to the Customer in an Emergency; never generated freely by the Agent.
_Avoid_: Safety advice, guidance
