import type { Database } from "./database";

/**
 * Ordered, append-only schema migrations. Never edit a migration that has been
 * deployed; add a new entry instead.
 */
export const migrations: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "0001_demo_session",
    sql: `
      CREATE TABLE demo_session (
        id          uuid PRIMARY KEY,
        created_at  timestamptz NOT NULL,
        expires_at  timestamptz NOT NULL
      );

      CREATE TABLE engineer (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        name        text NOT NULL,
        skills      text[] NOT NULL,
        sort_order  int NOT NULL
      );
      CREATE INDEX engineer_session_idx ON engineer (session_id);

      CREATE TABLE customer (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        full_name     text NOT NULL,
        postcode      text NOT NULL,
        email         text NOT NULL,
        phone         text,
        demo_friendly boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL
      );
      CREATE INDEX customer_session_idx ON customer (session_id);

      CREATE TABLE job (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_reference text NOT NULL,
        customer_id   uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
        issue_type    text NOT NULL,
        description   text NOT NULL,
        job_status    text NOT NULL,
        created_at    timestamptz NOT NULL,
        UNIQUE (session_id, job_reference)
      );

      CREATE TABLE visit (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id         uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_id             uuid NOT NULL REFERENCES job(id) ON DELETE CASCADE,
        engineer_id        uuid NOT NULL REFERENCES engineer(id) ON DELETE CASCADE,
        visit_date         date NOT NULL,
        time_window        text NOT NULL CHECK (time_window IN ('AM', 'PM')),
        is_emergency_visit boolean NOT NULL DEFAULT false
      );
      CREATE INDEX visit_session_idx ON visit (session_id, visit_date);
      -- An Engineer attends one Visit per Time Window; only an Emergency Visit
      -- may override a full calendar.
      CREATE UNIQUE INDEX visit_engineer_window_uniq
        ON visit (session_id, engineer_id, visit_date, time_window)
        WHERE NOT is_emergency_visit;

      CREATE TABLE parts_order (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id       uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_id           uuid NOT NULL REFERENCES job(id) ON DELETE CASCADE,
        part_name        text NOT NULL,
        parts_status     text NOT NULL,
        expected_arrival date NOT NULL,
        created_at       timestamptz NOT NULL
      );
      CREATE INDEX parts_order_session_idx ON parts_order (session_id);

      CREATE TABLE handoff_ticket (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id            uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        ticket_number         int NOT NULL,
        customer_id           uuid REFERENCES customer(id) ON DELETE CASCADE,
        job_id                uuid REFERENCES job(id) ON DELETE CASCADE,
        escalation_reason     text NOT NULL,
        urgency               text NOT NULL,
        status                text NOT NULL,
        summary               text NOT NULL,
        recommended_next_step text NOT NULL,
        created_at            timestamptz NOT NULL,
        UNIQUE (session_id, ticket_number)
      );
    `,
  },
  {
    id: "0002_agent_conversation",
    sql: `
      CREATE TABLE conversation (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL
      );
      CREATE INDEX conversation_session_idx ON conversation (session_id);

      -- The Customer-visible transcript (what the chat widget shows).
      CREATE TABLE chat_message (
        seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id              uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
        session_id      uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        speaker         text NOT NULL CHECK (speaker IN ('Customer', 'Agent')),
        kind            text NOT NULL,
        text            text NOT NULL,
        payload         jsonb,
        created_at      timestamptz NOT NULL
      );
      CREATE INDEX chat_message_conversation_idx ON chat_message (session_id, conversation_id, seq);

      -- The model's view of the conversation: Messages API entries, append-only,
      -- stored as the exact JSON sent (text, not jsonb) so replays are byte-identical.
      CREATE TABLE agent_message (
        seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        session_id      uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        message         text NOT NULL,
        created_at      timestamptz NOT NULL
      );
      CREATE INDEX agent_message_conversation_idx ON agent_message (session_id, conversation_id, seq);

      -- Notices for the model (escalation state etc.), delivered as a
      -- mid-conversation system message at the start of the next Customer turn.
      CREATE TABLE agent_system_note (
        seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        session_id      uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        text            text NOT NULL,
        delivered       boolean NOT NULL DEFAULT false,
        created_at      timestamptz NOT NULL
      );
      CREATE INDEX agent_system_note_pending_idx
        ON agent_system_note (session_id, conversation_id) WHERE NOT delivered;

      -- The Agent Trace: every tool call (and refusal/error) with inputs and result.
      CREATE TABLE agent_trace_entry (
        seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id              uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
        session_id      uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        kind            text NOT NULL,
        tool_name       text,
        input           jsonb,
        result          text,
        is_error        boolean NOT NULL DEFAULT false,
        created_at      timestamptz NOT NULL
      );
      CREATE INDEX agent_trace_entry_session_idx ON agent_trace_entry (session_id, seq);
    `,
  },
  {
    id: "0003_t6_verification",
    sql: `
      -- Verification state per conversation (#6): who the Customer proved they
      -- are, and how many failed attempts they have made (3 = locked).
      CREATE TABLE conversation_verification (
        conversation_id      uuid PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
        session_id           uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        verified_customer_id uuid REFERENCES customer(id) ON DELETE CASCADE,
        failed_attempts      int NOT NULL DEFAULT 0,
        updated_at           timestamptz NOT NULL
      );
      CREATE INDEX conversation_verification_session_idx ON conversation_verification (session_id);
    `,
  },
  {
    id: "0004_t7_session_rate_limit",
    sql: `
      -- Who started the Demo Session (a salted hash of the client IP, never the
      -- IP itself), for the new-Demo-Sessions-per-IP-per-hour guardrail.
      ALTER TABLE demo_session ADD COLUMN client_ip_hash text;
      CREATE INDEX demo_session_client_ip_idx ON demo_session (client_ip_hash, created_at)
        WHERE client_ip_hash IS NOT NULL;
      CREATE INDEX demo_session_expires_idx ON demo_session (expires_at);
    `,
  },
  {
    id: "0005_t5_pending_action",
    sql: `
      -- Two-phase Confirmation: a write the Agent has proposed (book,
      -- reschedule, cancel...) and read back, awaiting the Customer's reply.
      CREATE TABLE pending_action (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id               uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        conversation_id          uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        kind                     text NOT NULL,
        payload                  jsonb NOT NULL,
        read_back                jsonb NOT NULL,
        -- chat_message.seq of the Customer message in whose turn it was proposed.
        proposed_at_customer_seq bigint NOT NULL,
        status                   text NOT NULL
          CHECK (status IN ('Pending', 'Confirmed', 'Superseded', 'Failed')),
        result                   jsonb,
        created_at               timestamptz NOT NULL,
        resolved_at              timestamptz
      );
      CREATE INDEX pending_action_conversation_idx
        ON pending_action (session_id, conversation_id) WHERE status = 'Pending';
    `,
  },
  {
    id: "0006_t4_handoff_ticket_timeline",
    sql: `
      -- Handoff Tickets raised in chat belong to a conversation; seed tickets have none.
      ALTER TABLE handoff_ticket
        ADD COLUMN conversation_id uuid REFERENCES conversation(id) ON DELETE CASCADE;
      -- At most one open (not Resolved) ticket per Escalation Reason per conversation.
      CREATE UNIQUE INDEX handoff_ticket_open_reason_uniq
        ON handoff_ticket (session_id, conversation_id, escalation_reason)
        WHERE status <> 'Resolved' AND conversation_id IS NOT NULL;

      -- A ticket's timeline: what was added to it, oldest first.
      CREATE TABLE handoff_ticket_event (
        seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        ticket_id  uuid NOT NULL REFERENCES handoff_ticket(id) ON DELETE CASCADE,
        kind       text NOT NULL,
        text       text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX handoff_ticket_event_ticket_idx ON handoff_ticket_event (session_id, ticket_id, seq);
    `,
  },
  {
    id: "0007_t11_possible_duplicate_customer",
    sql: `
      -- Set when a Booking's email matched this existing Customer but the name or
      -- postcode didn't: an Operator should check and merge them.
      ALTER TABLE customer
        ADD COLUMN possible_duplicate_of uuid REFERENCES customer(id) ON DELETE CASCADE;
    `,
  },
  {
    id: "0008_t13_emergency_kind",
    sql: `
      -- Which Emergency an Emergency Handoff Ticket is for ('gas_or_co' or
      -- 'flood_or_sparks'); gas/CO wins once reported. NULL for other reasons.
      -- An open gas/CO ticket blocks booking in its conversation.
      ALTER TABLE handoff_ticket ADD COLUMN emergency_kind text;
    `,
  },
];

// Arbitrary constant key so concurrent cold starts don't migrate twice.
const MIGRATION_LOCK_KEY = 4_177_301;

export async function migrate(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM schema_migration");
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migration (id) VALUES ($1)", [m.id]);
    }
  });
}
