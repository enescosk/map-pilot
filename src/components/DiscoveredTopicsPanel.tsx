import { memo, useMemo, useState } from "react";
import type { TopicInfo } from "../types/liveMessages";

// Faz 1+2 — Topic discovery + selection. Lists what the vehicle advertises
// (from /rosapi/topics); clicking a row toggles a raw subscription (Faz 2).
// A search box filters by topic name or type (211 topics is a lot to scroll).
function DiscoveredTopicsPanel({
  topics,
  selected,
  onToggle,
}: {
  topics: TopicInfo[];
  selected: Set<string>;
  onToggle: (topic: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter(
      (t) => t.topic.toLowerCase().includes(q) || t.type.toLowerCase().includes(q),
    );
  }, [topics, query]);

  return (
    <section className="workspace-panel topic-workspace">
      <div className="panel-titlebar">
        <span>Keşfedilen Topic'ler</span>
        <strong>{query ? `${filtered.length}/${topics.length}` : topics.length || "—"}</strong>
      </div>
      {topics.length === 0 ? (
        <div className="latest-payload">
          <span>Araç bağlandığında yayınlanan topic'ler listelenir.</span>
        </div>
      ) : (
        <>
          <div className="topic-search">
            <input
              type="text"
              className="topic-search__input"
              placeholder="Topic ara (ad veya tip)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Topic ara"
            />
            {query && (
              <button
                type="button"
                className="topic-search__clear"
                onClick={() => setQuery("")}
                aria-label="Aramayı temizle"
                title="Temizle"
              >
                ×
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <div className="latest-payload">
              <span>"{query}" ile eşleşen topic yok.</span>
            </div>
          ) : (
            <ul className="discovered-topics">
              {filtered.map((t) => {
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
        </>
      )}
    </section>
  );
}

export default memo(DiscoveredTopicsPanel);
