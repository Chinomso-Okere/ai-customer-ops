import { TIME_WINDOWS } from "@/domain/time-window";
import type { CalendarVisit, DashboardState } from "@/server/demo-session";
import { formatDay, slug } from "./format";

/** Visits by Engineer × day × Time Window, one grid per week. */
export function VisitCalendar({ calendar }: { calendar: DashboardState["calendar"] }) {
  const byCell = new Map<string, CalendarVisit[]>();
  for (const v of calendar.visits) {
    const key = `${v.engineerId}|${v.date}|${v.timeWindow}`;
    byCell.set(key, [...(byCell.get(key) ?? []), v]);
  }
  const weeks = [calendar.days.slice(0, 5), calendar.days.slice(5, 10)];

  return (
    <section className="panel">
      <h3 className="panel__title">Calendar</h3>
      {weeks.map((days, w) => (
        <div className="calendar" key={w}>
          <table className="calendar__grid">
            <thead>
              <tr>
                <th className="calendar__corner">
                  {days.some((d) => d.isToday) ? "This week" : `Week of ${formatDay(days[0]!.date)}`}
                </th>
                {days.map((d) => (
                  <th key={d.date} colSpan={2} className={d.isToday ? "calendar__day calendar__day--today" : "calendar__day"}>
                    {formatDay(d.date)}
                  </th>
                ))}
              </tr>
              <tr>
                <th />
                {days.flatMap((d) =>
                  TIME_WINDOWS.map((tw) => (
                    <th key={`${d.date}${tw}`} className="calendar__window">
                      {tw}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {calendar.engineers.map((e) => (
                <tr key={e.id}>
                  <th className="calendar__engineer" title={e.skills.join(", ")}>
                    {e.name}
                  </th>
                  {days.flatMap((d) =>
                    TIME_WINDOWS.map((tw) => {
                      const visits = byCell.get(`${e.id}|${d.date}|${tw}`) ?? [];
                      return (
                        <td key={`${d.date}${tw}`} className="calendar__cell">
                          {visits.map((v) => (
                            <span
                              key={v.visitId}
                              className={`visit visit--${slug(v.issueType)}${v.isEmergencyVisit ? " visit--emergency" : ""}`}
                              title={`${v.isEmergencyVisit ? "Emergency Visit · " : ""}${v.jobReference} · ${v.issueType} · ${v.customerName}, ${v.postcode} · ${v.jobStatus}`}
                            >
                              {v.isEmergencyVisit ? "! " : ""}
                              {v.jobReference.replace("APX-", "")}
                            </span>
                          ))}
                        </td>
                      );
                    }),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
