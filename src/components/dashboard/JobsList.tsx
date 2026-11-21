import type { DashboardJob } from "@/server/demo-session";
import { formatDay, slug } from "./format";

export function JobsList({ jobs }: { jobs: DashboardJob[] }) {
  return (
    <section className="panel">
      <h3 className="panel__title">Jobs ({jobs.length})</h3>
      <div className="panel__scroll">
        <table className="list">
          <thead>
            <tr>
              <th>Job Reference</th>
              <th>Customer</th>
              <th>Issue Type</th>
              <th>Job Status</th>
              <th>Last / next Visit</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const visit = job.visits.at(-1);
              return (
                <tr key={job.id}>
                  <td className="mono">{job.jobReference}</td>
                  <td>
                    {job.customer.fullName}
                    <span className="muted"> · {job.customer.postcode}</span>
                  </td>
                  <td>{job.issueType}</td>
                  <td>
                    <span className={`status status--${slug(job.jobStatus)}`}>{job.jobStatus}</span>
                  </td>
                  <td>{visit ? `${formatDay(visit.date)} ${visit.timeWindow}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
