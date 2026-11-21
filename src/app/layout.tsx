import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apex Heating & Cooling — Agentic Customer Operations Demo",
  description:
    "A live demo of an AI Agent booking Visits, looking up Jobs and escalating to Operators for a fictional UK heating & cooling company.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
