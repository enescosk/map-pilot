import { useCallback, useMemo, useState } from "react";
import type { TopicHealthMessage } from "../types/liveMessages";
import type { TopicHealthState } from "../types/telemetry";

const emptyTopicHealth: TopicHealthState = {
  topics: {},
  sources: {},
};

export function useTopicHealth() {
  const [topicHealth, setTopicHealth] = useState<TopicHealthState>(emptyTopicHealth);

  const handleTopicHealthMessage = useCallback((message: TopicHealthMessage) => {
    setTopicHealth({
      time: message.time,
      topics: message.topics || {},
      sources: message.sources || {},
    });
  }, []);

  const summary = useMemo(() => {
    const topics = Object.values(topicHealth.topics);
    const sources = Object.values(topicHealth.sources);
    return {
      topicCount: topics.length,
      staleCount: topics.filter((topic) => topic.isStale).length,
      errorCount: topics.reduce((sum, topic) => sum + Number(topic.errorCount || 0), 0),
      connectedSources: sources.filter((source) => source.connected).length,
      sourceCount: sources.length,
    };
  }, [topicHealth]);

  return { topicHealth, topicHealthSummary: summary, handleTopicHealthMessage };
}
