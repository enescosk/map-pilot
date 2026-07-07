import { memo } from "react";
import type { RawMessage } from "../types/liveMessages";

// Faz 2 — Raw inspection view. Shows the latest message of each user-picked
// topic as pretty-printed JSON (Foxglove "Raw Messages" style). Works for any
// message type since it never tries to interpret the payload.
function RawMessagePanel({
  selected,
  messages,
}: {
  selected: Set<string>;
  messages: Record<string, RawMessage>;
}) {
  const picked = [...selected];
  return (
    <section className="workspace-panel raw-workspace">
      <div className="panel-titlebar">
        <span>Ham Mesajlar</span>
        <strong>{picked.length || "—"}</strong>
      </div>
      {picked.length === 0 ? (
        <div className="latest-payload">
          <span>Soldaki listeden bir topic seçince ham verisi burada görünür.</span>
        </div>
      ) : (
        <div className="raw-messages">
          {picked.map((topic) => {
            const m = messages[topic];
            return (
              <div key={topic} className="raw-messages__item">
                <div className="raw-messages__head">
                  <span className="raw-messages__topic">{topic}</span>
                  <span className="raw-messages__type">{m?.msgType || "—"}</span>
                </div>
                <pre className="raw-messages__body">
                  {m ? safeStringify(m.msg) : "veri bekleniyor…"}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default memo(RawMessagePanel);
