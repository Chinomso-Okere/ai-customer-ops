import { COVERAGE_AREA } from "@/domain/coverage-area";

/**
 * The Price List & FAQ: the only prices and answers the Agent may quote. A
 * small fixed document embedded in the system prompt (no retrieval). Any price
 * not listed here is Out of Policy.
 */
export const PRICE_LIST = [
  { item: "Call-out & diagnosis", price: "£95" },
  { item: "Annual boiler service", price: "£89" },
  { item: "Boiler repair labour", price: "£75 per hour, plus parts" },
  { item: "AC service", price: "£120" },
  { item: "Heat pump survey", price: "Free" },
] as const;

export const FAQ = [
  {
    question: "When do Engineers visit?",
    answer:
      "Weekdays only, in two Time Windows: AM (08:00–12:00) or PM (12:00–17:00). The Engineer arrives within the window.",
  },
  {
    question: "Which areas do you cover?",
    answer: `These London outward postcodes: ${COVERAGE_AREA.join(", ")}. Customers outside them cannot be booked.`,
  },
  {
    question: "What work do you do?",
    answer:
      "Boiler Repair, Boiler Service, Radiators & Heating, AC Repair & Install, and Heat Pump work. Only Engineers skilled for the Issue Type attend.",
  },
  {
    question: "Can I change or cancel a Visit?",
    answer:
      "Yes, more than 24 hours before the Visit. Changes within 24 hours are passed to the team, and a late-change fee may apply.",
  },
  {
    question: "I smell gas. What do I do?",
    answer:
      "Don't use electrical switches or naked flames, open doors and windows, leave the property, and call the National Gas Emergency number 0800 111 999.",
  },
] as const;

export function renderPriceList(): string {
  const prices = PRICE_LIST.map((p) => `- ${p.item}: ${p.price}`).join("\n");
  const faq = FAQ.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
  return `# Price List & FAQ\n\n## Prices\n${prices}\n\n## FAQ\n${faq}`;
}
