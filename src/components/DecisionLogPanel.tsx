import { memo } from "react";

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
        <p className="panel-label">Otonom</p>
        <h2>Karar Günlüğü</h2>
      </div>

      <div className="decision-list">
        {entries.length === 0 ? (
          <div className="decision-empty">
            <span className="decision-empty-dot" aria-hidden />
            <span className="decision-empty-title">Karar bekleniyor</span>
            <span className="decision-empty-hint">Otonom sürüş kararları burada listelenecek</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div className="decision-row" key={entry.id}>
              <span>{entry.time}</span>
              <div>
                <strong>{entry.source}</strong>
                <p>{entry.message}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </article>
  );
}

export default memo(DecisionLogPanel);
