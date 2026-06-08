import { memo, useState } from "react";
import type { TopicHealthState } from "../types/telemetry";

type TopicHealthStripProps = {
  health: TopicHealthState;
  sourceLabel: string;
  modeKind: string;
  waitingMessage: string;
};

function TopicHealthStrip({ health, sourceLabel, modeKind, waitingMessage }: TopicHealthStripProps) {
  const [expanded, setExpanded] = useState(false);
  const topics = Object.entries(health.topics || {});
  const sources = Object.entries(health.sources || {});
  const staleTopics = topics.filter(([, t]) => t.isStale);
  const errorTopics = topics.filter(([, t]) => Number(t.errorCount || 0) > 0);
  const staleCount = staleTopics.length;
  const errorCount = topics.reduce((sum, [, t]) => sum + Number(t.errorCount || 0), 0);
  const connectedCount = sources.filter(([, s]) => s.connected).length;
  const hasTopics = topics.length > 0;
  const hasProblems = staleCount > 0 || errorCount > 0;

  return (
    <section className="topic-health-strip" aria-label="Topic health">
      <span className={hasTopics && staleCount === 0 ? "health-dot fresh" : "health-dot missing"} />
      <strong>{modeKind}: {sourceLabel}</strong>
      <span>{hasTopics ? `${topics.length} topic` : waitingMessage}</span>
      <span className={staleCount > 0 ? "health-warn" : ""}>
        {staleCount > 0 ? `${staleCount} stale` : hasTopics ? "fresh" : "missing"}
      </span>
      <span className={errorCount > 0 ? "health-error" : ""}>
        {errorCount > 0 ? `${errorCount} hata` : "hata yok"}
      </span>
      <span className={connectedCount > 0 ? "source-state connected" : "source-state disconnected"}>
        {sources.length > 0 ? `${connectedCount}/${sources.length} kaynak` : "kaynak bilinmiyor"}
      </span>
      {hasProblems && (
        <button
          type="button"
          className="health-detail-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "▲ gizle" : "▼ detay"}
        </button>
      )}
      {expanded && hasProblems && (
        <div className="health-detail-dropdown">
          {staleTopics.length > 0 && (
            <div className="health-detail-group">
              <span className="health-detail-label health-warn">Stale ({staleTopics.length})</span>
              {staleTopics.map(([name, t]) => (
                <span key={name} className="health-detail-item" title={`${t.hitCount} paket, ${Math.round(t.ageMs / 1000)}s önce`}>
                  {name}
                </span>
              ))}
            </div>
          )}
          {errorTopics.length > 0 && (
            <div className="health-detail-group">
              <span className="health-detail-label health-error">Hatalı ({errorTopics.length})</span>
              {errorTopics.map(([name, t]) => (
                <span key={name} className="health-detail-item" title={t.lastError || ""}>
                  {name} ({t.errorCount})
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default memo(TopicHealthStrip);
