/** Display helpers shared by dashboard panels. PlainDates are London dates. */

export function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function formatAge(isoInstant: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(isoInstant).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A CSS-safe modifier for a domain value, e.g. "Awaiting Parts" → "awaiting-parts". */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
