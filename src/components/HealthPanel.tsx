import type { SystemHealthItem } from "../App";

type HealthPanelProps = {
  items: SystemHealthItem[];
};

function HealthPanel({ items }: HealthPanelProps) {
  const problemCount = items.filter((item) => !item.isActive).length;

  return (
    <article className="panel health-panel">
      <div className="panel-heading split-heading">
        <div>
          <p className="panel-label">Faults</p>
          <h2>System Health</h2>
        </div>
        <span className={problemCount === 0 ? "system-pill active" : "system-pill inactive"}>
          {problemCount === 0 ? "All Active" : `${problemCount} Problem`}
        </span>
      </div>

      <div className="health-list">
        {items.map((item) => (
          <div className="health-row" key={item.name}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.detail}</span>
            </div>
            <span className={item.isActive ? "state-text active" : "state-text inactive"}>
              {item.isActive ? "Active" : "Inactive"}
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}

export default HealthPanel;
