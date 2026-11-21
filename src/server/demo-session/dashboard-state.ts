import type { IssueType, JobStatus } from "@/domain/vocabulary";
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

export interface DashboardJob {
  id: string;
  jobReference: string;
  issueType: IssueType;
  description: string;
  jobStatus: JobStatus;
  createdAt: string;
  customer: DashboardCustomer;
}

/** Everything the Operations Dashboard shows for one Demo Session. JSON-safe. */
export interface DashboardState {
  sessionId: string;
  calendar: {
    engineers: DashboardEngineer[];
  };
  /** Newest Job Reference first. */
  jobs: DashboardJob[];
}

export async function readDashboardState(
  db: Database,
  sessionId: string,
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

  return {
    sessionId,
    calendar: { engineers: engineers.rows },
    jobs: jobs.rows.map((r) => ({
      id: r.id,
      jobReference: r.job_reference,
      issueType: r.issue_type,
      description: r.description,
      jobStatus: r.job_status,
      createdAt: r.created_at.toISOString(),
      customer: { fullName: r.full_name, postcode: r.postcode, email: r.email },
    })),
  };
}
