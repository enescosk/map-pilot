type DecisionLogEntry = {
  id: string;
  time: string;
  source: string;
  message: string;
};

type DecisionLogPanelProps = {
  entries: DecisionLogEntry[];
};

function DecisionLogPanel({ entries }: DecisionLogPanelProps) {
  return (
    <article className="panel decision-panel">
      <div className="panel-heading">
        <p className="panel-label">Autonomy</p>
        <h2>Decision Log</h2>
      </div>

      <div className="decision-list">
        {entries.map((entry) => (
          <div className="decision-row" key={entry.id}>
            <span>{entry.time}</span>
            <div>
              <strong>{entry.source}</strong>
              <p>{entry.message}</p>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

export default DecisionLogPanel;
