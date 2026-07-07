import { memo } from "react";
import type { TopicInfo } from "../types/liveMessages";

// Faz 1+2 — Topic discovery + selection. Lists what the vehicle advertises
// (from /rosapi/topics); clicking a row toggles a raw subscription (Faz 2).
function DiscoveredTopicsPanel({
  topics,
  selected,
  onToggle,
}: {
  topics: TopicInfo[];
  selected: Set<string>;
  onToggle: (topic: string) => void;
}) {
  return (
    <section className="workspace-panel topic-workspace">
      <div className="panel-titlebar">
        <span>Keşfedilen Topic'ler</span>
        <strong>{topics.length || "—"}</strong>
      </div>
      {topics.length === 0 ? (
        <div className="latest-payload">
          <span>Araç bağlandığında yayınlanan topic'ler listelenir.</span>
        </div>
      ) : (
        <ul className="discovered-topics">
          {topics.map((t) => {
            const isOn = selected.has(t.topic);
            return (
              <li key={t.topic}>
                <button
                  type="button"
                  className={`discovered-topics__row${isOn ? " discovered-topics__row--on" : ""}`}
                  onClick={() => onToggle(t.topic)}
                  title={isOn ? "Aboneliği kaldır" : "Ham veriyi izle"}
                >
                  <span className="discovered-topics__check">{isOn ? "‣" : ""}</span>
                  <span className="discovered-topics__name">{t.topic}</span>
                  <span className="discovered-topics__type">{t.type}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default memo(DiscoveredTopicsPanel);
