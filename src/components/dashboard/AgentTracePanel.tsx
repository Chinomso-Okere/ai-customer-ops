import type { AgentTraceEntry } from "@/server/demo-session";
import { formatAge } from "./format";

const KIND_LABELS: Record<string, string> = {
  tool_call: "Tool call",
  refusal: "Model refusal",
  error: "Error",
  emergency_prefilter: "Emergency pre-filter",
};

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

/** The live Agent Trace: every tool the Agent called and what came back, newest first. */
export function AgentTracePanel({ entries }: { entries: AgentTraceEntry[] }) {
  const newestFirst = [...entries].reverse();
  return (
    <section className="panel">
      <h3 className="panel__title">Agent Trace ({entries.length})</h3>
      {entries.length === 0 ? (
        <p className="muted">No tool calls yet. Chat with the Agent to see its actions here.</p>
      ) : (
        <ol className="trace panel__scroll">
          {newestFirst.map((e) => (
            <li key={e.id} className={`trace__entry${e.isError ? " trace__entry--error" : ""}`}>
              <div className="trace__head">
                <span className="mono trace__tool">{e.toolName ?? KIND_LABELS[e.kind] ?? e.kind}</span>
                {e.toolName && e.kind !== "tool_call" && <span className="muted">{KIND_LABELS[e.kind] ?? e.kind}</span>}
                {e.isError && <span className="status status--open">is_error</span>}
                <span className="muted trace__age">{formatAge(e.createdAt)}</span>
              </div>
              {e.input !== null && (
                <pre className="trace__io">
                  <span className="muted">input </span>
                  {pretty(e.input)}
                </pre>
              )}
              {e.result !== null && (
                <pre className="trace__io">
                  <span className="muted">result </span>
                  {pretty(e.result)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
