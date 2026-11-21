/** The outward postcodes Apex serves (London SW/SE). */
export const COVERAGE_AREA = [
  "SW2",
  "SW4",
  "SW8",
  "SW9",
  "SW11",
  "SW12",
  "SE5",
  "SE11",
  "SE15",
  "SE22",
] as const;

/** Postcodes are compared with spaces removed and uppercased ("sw4 7aa" → "SW47AA"). */
export function normalisePostcode(postcode: string): string {
  return postcode.replace(/\s+/g, "").toUpperCase();
}

/** The outward code of a full UK postcode ("SW4 7AA" → "SW4"). */
export function outwardCode(postcode: string): string {
  const normalised = normalisePostcode(postcode);
  // The inward code is always the final 3 characters.
  return normalised.length > 3 ? normalised.slice(0, -3) : normalised;
}

export function isInCoverageArea(postcode: string): boolean {
  return (COVERAGE_AREA as readonly string[]).includes(outwardCode(postcode));
}

/** A postcode in display form: normalised, with a space before the inward code ("sw49zz" -> "SW4 9ZZ"). */
export function formatPostcode(postcode: string): string {
  const normalised = normalisePostcode(postcode);
  return normalised.length > 3 ? `${normalised.slice(0, -3)} ${normalised.slice(-3)}` : normalised;
}
