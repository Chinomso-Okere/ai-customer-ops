import type { EmergencyKind } from "@/domain/emergency-prefilter";

/**
 * The fixed Safety Script per Emergency kind. Never model-generated (ADR-0002).
 * The chat widget renders `bullets` as short, high-contrast points.
 */
export interface SafetyScript {
  emergencyKind: EmergencyKind;
  title: string;
  bullets: readonly string[];
}

export const SAFETY_SCRIPTS: Readonly<Record<EmergencyKind, SafetyScript>> = {
  gas_or_co: {
    emergencyKind: "gas_or_co",
    title: "Possible gas leak or carbon monoxide: act now",
    bullets: [
      "Don't use light switches, plugs or anything electrical.",
      "No flames, no smoking.",
      "Open doors and windows.",
      "Turn off the gas at the meter if you can do it safely.",
      "Leave the property now.",
      "Call National Gas Emergency: 0800 111 999 (free, 24/7).",
      "If anyone feels unwell, call 999.",
    ],
  },
  flood_or_sparks: {
    emergencyKind: "flood_or_sparks",
    title: "Water or electrical danger: act now",
    bullets: [
      "Keep away from water near sockets, switches or appliances.",
      "Don't touch anything that is sparking.",
      "Switch off the electricity at the fuse box if you can do it safely.",
      "Turn off the water at the stopcock if you can do it safely.",
      "If there is fire or anyone is hurt, call 999.",
    ],
  },
};

/** The Safety Script as plain text, for transcripts and the model's history. */
export function safetyScriptText(script: SafetyScript): string {
  return [script.title, ...script.bullets.map((b) => `- ${b}`)].join("\n");
}
