import type { DashboardCustomer, PossibleDuplicateCustomer } from "@/server/demo-session";

/**
 * Story 28: Customers booked under an email already on file but with a
 * different name or postcode, flagged for an Operator to check and merge.
 */
export function PossibleDuplicatesPanel({ duplicates }: { duplicates: PossibleDuplicateCustomer[] }) {
  return (
    <section className="panel" aria-labelledby="duplicates-title">
      <h3 className="panel__title" id="duplicates-title">
        Possible duplicate Customers{" "}
        {duplicates.length > 0 && <span className="badge badge--warn">{duplicates.length} to check</span>}
      </h3>
      {duplicates.length === 0 ? (
        <p className="muted duplicates__empty">None. A booking whose email matches another Customer&apos;s shows up here.</p>
      ) : (
        <ul className="duplicates">
          {duplicates.map((d, i) => (
            <li key={`${i}|${d.jobReferences.join(",")}`} className="duplicates__item">
              <CustomerLine label="New" customer={d.customer} jobReferences={d.jobReferences} />
              <CustomerLine label="Same email as" customer={d.possibleDuplicateOf} jobReferences={d.possibleDuplicateOf.jobReferences} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CustomerLine({
  label,
  customer,
  jobReferences,
}: {
  label: string;
  customer: DashboardCustomer;
  jobReferences: string[];
}) {
  return (
    <div className="duplicates__line">
      <span className="duplicates__label muted">{label}</span>{" "}
      <strong>{customer.fullName}</strong>, {customer.postcode} · <span className="duplicates__email">{customer.email}</span>
      {jobReferences.length > 0 && <span className="mono"> · {jobReferences.join(", ")}</span>}
    </div>
  );
}
