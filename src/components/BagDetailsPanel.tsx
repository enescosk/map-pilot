import type { BagStatus } from "../types/liveMessages";

type BagFrame = {
  topic: string;
  time?: string;
  messageType: string;
  preview: string;
};

type BagDetailsPanelProps = {
  status: BagStatus;
  latestFrame?: BagFrame;
};

function BagDetailsPanel({ status, latestFrame }: BagDetailsPanelProps) {
  return (
    <article className="panel bag-panel">
      <div className="panel-heading split-heading">
        <div>
          <p className="panel-label">Dataset</p>
          <h2>Bag Details</h2>
        </div>
        <span className={status.playing ? "system-pill active" : "system-pill inactive"}>
          {status.playing ? "Playing" : "Idle"}
        </span>
      </div>

      <div className="bag-overview">
        <div>
          <span>Frames</span>
          <strong>{status.frameCount}</strong>
        </div>
        <div>
          <span>Cursor</span>
          <strong>{status.cursor}</strong>
        </div>
        <div>
          <span>Topics</span>
          <strong>{status.topics.length}</strong>
        </div>
      </div>

      <div className="topic-list">
        {status.topics.length === 0 ? (
          <p className="panel-note">No bag export loaded yet.</p>
        ) : (
          status.topics.map((topic) => (
            <div className="topic-row" key={topic.topic}>
              <div>
                <strong>{topic.topic}</strong>
                <span>{topic.type}</span>
              </div>
              <span>{topic.count} messages</span>
            </div>
          ))
        )}
      </div>

      {latestFrame && (
        <div className="latest-frame">
          <span>Latest frame</span>
          <strong>{latestFrame.topic}</strong>
          <code>{latestFrame.preview}</code>
        </div>
      )}

      <p className="bag-path">{status.path || "Set BAG_EXPORT_PATH to a JSON/JSONL export file."}</p>
    </article>
  );
}

export default BagDetailsPanel;
