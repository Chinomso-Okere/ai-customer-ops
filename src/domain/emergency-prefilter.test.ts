import { describe, expect, it } from "vitest";
import { detectEmergency, type EmergencyMatch } from "./emergency-prefilter";

type Expected = EmergencyMatch["match"];

// Seam 2 (ADR-0002): the deterministic Emergency pre-filter.
const CASES: Array<[text: string, expected: Expected]> = [
  // True positives
  ["I smell gas", "gas_or_co"],
  ["I can smell gas in the kitchen", "gas_or_co"],
  ["There's a strong smell of gas", "gas_or_co"],
  ["it smells like gas upstairs", "gas_or_co"],
  ["Gas smell near the boiler", "gas_or_co"],
  ["I think we have a GAS LEAK", "gas_or_co"],
  ["the cooker is leaking gas", "gas_or_co"],
  ["My CO alarm keeps beeping", "gas_or_co"],
  ["the co-alarm is going off", "gas_or_co"],
  ["carbon monoxide detector going off", "gas_or_co"],
  ["Water pouring through the ceiling!", "flood_or_sparks"],
  ["the kitchen is flooding", "flood_or_sparks"],
  ["Our basement flooded overnight", "flood_or_sparks"],
  ["sparks coming out of the socket", "flood_or_sparks"],
  ["the boiler is sparking", "flood_or_sparks"],
  // Hedges never suppress
  ["might be carbon monoxide?", "gas_or_co"],
  ["I think I smell gas", "gas_or_co"],
  ["maybe a gas leak, not sure", "gas_or_co"],
  ["I don't think so but maybe it's flooding", "flood_or_sparks"],
  // Negations immediately before the phrase suppress
  ["no gas smell, I just want a boiler service", "none"],
  ["There's no smell of gas", "none"],
  ["it's not flooding, just a slow drip", "none"],
  ["the bathroom isn't flooded", "none"],
  ["I don't smell gas", "none"],
  ["not a gas leak, the pilot light keeps going out", "none"],
  // Near-misses
  ["I'd like a gas boiler service please", "none"],
  ["Is your engineer Gas Safe registered?", "none"],
  ["How much is a gas safety certificate?", "none"],
  ["My gas bill is huge", "none"],
  ["Book a Gas Safe engineer for my boiler", "none"],
  // Mid-sentence and mixed cases
  ["Booking a service for Friday but actually I can smell gas right now", "gas_or_co"],
  ["No gas smell earlier, but now I smell gas", "gas_or_co"],
  ["no flooding, but there are sparks from the fuse box", "flood_or_sparks"],
  ["Service please. No. Gas leak!", "gas_or_co"],
  ["not flooding but the CO alarm went off", "gas_or_co"],
];

describe("Emergency pre-filter", () => {
  it.each(CASES)("%j -> %s", (text, expected) => {
    expect(detectEmergency(text).match).toBe(expected);
  });

  it("reports the phrase that fired", () => {
    const result = detectEmergency("Help, I smell gas!");
    expect(result).toEqual({ match: "gas_or_co", phrase: "smell gas" });
  });
});
