import { memo, useEffect, useState } from "react";
import type { RawMessage } from "../types/liveMessages";

// After this many seconds with no message, tell the user the topic is likely
// silent rather than leaving an ambiguous "veri bekleniyor…".
const SILENT_AFTER_S = 3;

// Faz 2 — Raw inspection view. Shows the latest message of each user-picked
// topic as pretty-printed JSON (Foxglove "Raw Messages" style). Works for any
// message type since it never tries to interpret the payload.
function RawMessagePanel({
  selected,
  messages,
  selectedAt,
}: {
  selected: Set<string>;
  messages: Record<string, RawMessage>;
  selectedAt: Record<string, number>;
}) {
  const picked = [...selected];

  // 1 Hz tick so the "N sn'dir veri yok" counter advances while we wait.
  const [, force] = useState(0);
  useEffect(() => {
    if (picked.length === 0) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [picked.length]);

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
            const waited = Math.floor((Date.now() - (selectedAt[topic] || Date.now())) / 1000);
            const silent = !m && waited >= SILENT_AFTER_S;
            return (
              <div key={topic} className="raw-messages__item">
                <div className="raw-messages__head">
                  <span className="raw-messages__topic">{topic}</span>
                  <span className="raw-messages__type">{m?.msgType || "—"}</span>
                </div>
                {m ? (
                  <pre className="raw-messages__body">{safeStringify(m.msg)}</pre>
                ) : silent ? (
                  <p className="raw-messages__silent">
                    {waited} sn'dir veri yok — topic sessiz olabilir (publish etmiyor).
                  </p>
                ) : (
                  <p className="raw-messages__waiting">veri bekleniyor…</p>
                )}
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
