import { memo } from "react";
import type { TopicInfo } from "../types/liveMessages";

// Faz 1 — Topic discovery. Read-only view of what the vehicle advertises
// (from /rosapi/topics). No subscription control yet; that is Faz 2.
function DiscoveredTopicsPanel({ topics }: { topics: TopicInfo[] }) {
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
          {topics.map((t) => (
            <li key={t.topic} className="discovered-topics__row" title={t.type}>
              <span className="discovered-topics__name">{t.topic}</span>
              <span className="discovered-topics__type">{t.type}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default memo(DiscoveredTopicsPanel);
