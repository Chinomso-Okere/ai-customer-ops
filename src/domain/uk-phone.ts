/**
 * Normalises a UK phone number to international form ("+447700900123"), or
 * returns undefined for obvious junk (letters, a foreign country code, the
 * wrong number of digits). Spaces, dashes, dots and brackets are ignored, and
 * a trunk "(0)" after the country code is dropped.
 */
export function normaliseUkPhone(raw: string): string | undefined {
  const text = raw.trim().replace(/^(\+44|0044)\s*\(0\)/, "$1");
  if (!/^\+?[\d\s().-]+$/.test(text)) return undefined;
  const digits = text.replace(/\D/g, "");
  const national = text.startsWith("+44") ? `0${digits.slice(2)}` : digits.startsWith("0044") ? `0${digits.slice(4)}` : digits;
  // A UK national number is a trunk 0 and ten digits, the first of which is 1, 2, 3, 7 or 8.
  return /^0[12378]\d{9}$/.test(national) ? `+44${national.slice(1)}` : undefined;
}

/**
 * A callback number for an Emergency: a UK number (as `normaliseUkPhone`) or an
 * international one written with a leading "+" and 8 to 15 digits, returned as
 * "+" and the digits. Safety comes before coverage, so a Customer abroad can
 * still leave a number. A "+44" number must be a valid UK number.
 */
export function normaliseCallbackPhone(raw: string): string | undefined {
  const uk = normaliseUkPhone(raw);
  if (uk) return uk;
  const text = raw.trim();
  if (!/^\+[\d\s().-]+$/.test(text)) return undefined;
  const digits = text.replace(/\D/g, "");
  if (digits.startsWith("44")) return undefined;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : undefined;
}
