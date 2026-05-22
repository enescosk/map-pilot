import type { TopicHealthState } from "../types/telemetry";

type TopicHealthStripProps = {
  health: TopicHealthState;
  sourceLabel: string;
  modeKind: string;
  waitingMessage: string;
};

function TopicHealthStrip({ health, sourceLabel, modeKind, waitingMessage }: TopicHealthStripProps) {
  const topics = Object.entries(health.topics || {});
  const sources = Object.entries(health.sources || {});
  const staleCount = topics.filter(([, topic]) => topic.isStale).length;
  const errorCount = topics.reduce((sum, [, topic]) => sum + Number(topic.errorCount || 0), 0);
  const connectedCount = sources.filter(([, source]) => source.connected).length;
  const hasTopics = topics.length > 0;

  return (
    <section className="topic-health-strip" aria-label="Topic health">
      <span className={hasTopics && staleCount === 0 ? "health-dot fresh" : "health-dot missing"} />
      <strong>{modeKind}: {sourceLabel}</strong>
      <span>{hasTopics ? `${topics.length} topics` : waitingMessage}</span>
      <span>{staleCount > 0 ? `${staleCount} stale` : hasTopics ? "fresh" : "missing"}</span>
      <span>{errorCount > 0 ? `${errorCount} errors` : "no errors"}</span>
      <span className={connectedCount > 0 ? "source-state connected" : "source-state disconnected"}>
        {sources.length > 0 ? `${connectedCount}/${sources.length} sources` : "source unknown"}
      </span>
    </section>
  );
}

export default TopicHealthStrip;
