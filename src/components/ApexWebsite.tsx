"use client";

import { useState } from "react";
import type { DashboardState } from "@/server/demo-session";
import { ChatWidget, type OutgoingChatMessage } from "./ChatWidget";
import { ScenarioTray } from "./ScenarioTray";

const SERVICES = [
  { name: "Boiler Service", blurb: "Annual service from £89." },
  { name: "Boiler Repair", blurb: "Call-out & diagnosis £95." },
  { name: "Radiators & Heating", blurb: "Cold spots, leaks, powerflushes." },
  { name: "AC Repair & Install", blurb: "Servicing from £120." },
  { name: "Heat Pump", blurb: "Free heat pump survey." },
];

/** The fake Apex Heating & Cooling website the Customer chats from. */
export function ApexWebsite({
  sessionId,
  state = null,
}: {
  sessionId: string | null;
  /** Live Demo Session state, for the scenario tray's demo Customer details. */
  state?: DashboardState | null;
}) {
  const [outgoing, setOutgoing] = useState<OutgoingChatMessage | null>(null);
  const sendScenario = (text: string) => setOutgoing((prev) => ({ id: (prev?.id ?? 0) + 1, text }));

  return (
    <div className="site">
      <div className="site__hero">
        <p className="site__brand">Apex Heating &amp; Cooling</p>
        <h1 className="site__headline">Warm homes, cool summers, across south London.</h1>
        <p className="site__sub">
          Gas Safe boiler engineers, AC and heat pump specialists covering London SW &amp; SE.
        </p>
      </div>
      <ul className="site__services">
        {SERVICES.map((s) => (
          <li key={s.name} className="site__service">
            <strong>{s.name}</strong>
            <span>{s.blurb}</span>
          </li>
        ))}
      </ul>
      <p className="site__fictional">
        Apex Heating &amp; Cooling is fictional and exists only for this demo. Any resemblance to a
        real company is coincidental.
      </p>
      <ScenarioTray state={state} onSend={sendScenario} disabled={!sessionId} />
      <ChatWidget sessionId={sessionId} outgoing={outgoing} />
    </div>
  );
}
