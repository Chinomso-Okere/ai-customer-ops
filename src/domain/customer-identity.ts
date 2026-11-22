/** "Sarah  MITCHELL " → "sarah mitchell". */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normaliseEmail(email: string): string {
  return email.replace(/\s+/g, "").toLowerCase();
}
