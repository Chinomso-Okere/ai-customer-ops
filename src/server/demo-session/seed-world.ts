import type { IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";

export interface EngineerSeed {
  name: string;
  skills: IssueType[];
}

/** 5 Engineers with overlapping skills across the Issue Types. */
export const ENGINEERS: EngineerSeed[] = [
  { name: "Dave Okafor", skills: ["Boiler Repair", "Boiler Service", "Radiators & Heating"] },
  { name: "Priya Shah", skills: ["Boiler Service", "Radiators & Heating", "Heat Pump"] },
  { name: "Tom Whitaker", skills: ["AC Repair & Install", "Heat Pump"] },
  { name: "Marta Kowalski", skills: ["Boiler Repair", "Boiler Service", "AC Repair & Install"] },
  { name: "Leon Grant", skills: ["Boiler Repair", "Radiators & Heating", "Heat Pump"] },
];

/** Seeds a complete Apex world into `sessionId`, with dates relative to `now`. */
export async function seedWorld(tx: Database, sessionId: string, now: Date): Promise<void> {
  void now;
  for (const [i, e] of ENGINEERS.entries()) {
    await tx.query(
      "INSERT INTO engineer (session_id, name, skills, sort_order) VALUES ($1, $2, $3, $4)",
      [sessionId, e.name, e.skills, i],
    );
  }
}
