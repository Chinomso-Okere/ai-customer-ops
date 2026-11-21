/**
 * The Emergency pre-filter (ADR-0002): deterministic rules, run on every
 * Customer message before the model. It must stay plain code.
 *
 * Rules: a listed phrase (or close variant) fires; a negation immediately
 * before it ("no gas smell", "not flooding", "isn't flooded") suppresses that
 * occurrence; hedges ("might", "think", "maybe") never suppress. On doubt, fire.
 */

export type EmergencyKind = "gas_or_co" | "flood_or_sparks";

export type EmergencyMatch =
  | { match: "none" }
  | {
      match: EmergencyKind;
      /** The phrase that fired, as normalised text (e.g. "smell gas"). */
      phrase: string;
    };

/** Gas/CO first: when both kinds fire, the more dangerous one wins. */
const PHRASES: ReadonlyArray<[EmergencyKind, RegExp]> = [
  ["gas_or_co", /\bsmell(?:s|ing|ed|t)?(?: of| like)? gas\b/g],
  ["gas_or_co", /\bgas smells?\b/g],
  ["gas_or_co", /\bwhiff of gas\b/g],
  ["gas_or_co", /\bgas (?:is )?leak(?:s|ing|ed)?\b/g],
  ["gas_or_co", /\bleak(?:s|ing|ed)?(?: of)? gas\b/g],
  ["gas_or_co", /\bco (?:alarm|detector)s?\b/g],
  ["gas_or_co", /\bcarbon monoxide\b/g],
  ["flood_or_sparks", /\bwater(?: is|'s)? (?:pouring|gushing)\b/g],
  ["flood_or_sparks", /\b(?:pouring|gushing) water\b/g],
  ["flood_or_sparks", /\bflood(?:s|ing|ed)?\b/g],
  ["flood_or_sparks", /\bspark(?:s|ing|ed)\b/g],
];

const NEGATIONS = new Set(["no", "not", "never", "without", "nothing", "none", "cannot", "isnt", "dont", "doesnt", "cant", "wasnt", "arent"]);
/** Words that may sit between a negation and the phrase: "not a gas leak", "no real smell of gas". */
const FILLERS = new Set(["a", "an", "any", "the", "really", "actually", "even", "real"]);
/** Sentence punctuation becomes this token, so a negation never reaches across it ("No. Gas leak!"). */
const BOUNDARY = "|";

export function detectEmergency(text: string): EmergencyMatch {
  const normalised = normalise(text);
  for (const [kind, pattern] of PHRASES) {
    for (const found of normalised.matchAll(pattern)) {
      if (!isNegated(normalised.slice(0, found.index))) return { match: kind, phrase: found[0] };
    }
  }
  return { match: "none" };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[.,!?;:()–—]+/g, ` ${BOUNDARY} `)
    .replace(/[^a-z0-9'| ]+/g, " ")
    .replace(/\s+/g, " ");
}

function isNegated(before: string): boolean {
  const words = before.trim().split(" ").reverse();
  for (const word of words) {
    if (FILLERS.has(word)) continue;
    const bare = word.replace(/'/g, "");
    return NEGATIONS.has(bare) || word.endsWith("n't");
  }
  return false;
}
