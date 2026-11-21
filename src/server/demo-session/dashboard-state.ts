import type { IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";

export interface DashboardEngineer {
  id: string;
  name: string;
  skills: IssueType[];
}

/** Everything the Operations Dashboard shows for one Demo Session. */
export interface DashboardState {
  sessionId: string;
  calendar: {
    engineers: DashboardEngineer[];
  };
}

export async function readDashboardState(
  db: Database,
  sessionId: string,
): Promise<DashboardState> {
  const engineers = await db.query<DashboardEngineer>(
    "SELECT id, name, skills FROM engineer WHERE session_id = $1 ORDER BY sort_order",
    [sessionId],
  );
  return { sessionId, calendar: { engineers: engineers.rows } };
}
