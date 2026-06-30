// Shared placeholder for panels that have no data yet (camera, map, lidar…).
// A pulsing icon + a primary line + an optional hint, so an idle demo panel
// reads as "waiting / connecting" rather than broken.

type EmptyStateProps = {
  icon?: "camera" | "map" | "lidar" | "signal";
  title: string;
  hint?: string;
  /** when true, show the animated "connecting" pulse */
  connecting?: boolean;
};

const ICONS: Record<NonNullable<EmptyStateProps["icon"]>, string> = {
  camera: "M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm8 3.2A3.3 3.3 0 1 0 12 16.8 3.3 3.3 0 0 0 12 10.2Z",
  map: "M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Zm0 0v16m6-14v16",
  lidar: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 3v3m0 12v3m9-9h-3M6 12H3m12.7-6.7-2.1 2.1m-3.2 3.2-2.1 2.1m9.5 0-2.1-2.1m-3.2-3.2L8.3 5.3",
  signal: "M5 12.5 10 17.5 19 6.5",
};

export function EmptyState({ icon = "camera", title, hint, connecting }: EmptyStateProps) {
  return (
    <div className={connecting ? "empty-state rich connecting" : "empty-state rich"}>
      <span className="empty-icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d={ICONS[icon]} />
        </svg>
      </span>
      <span className="empty-title">{title}</span>
      {hint && <span className="empty-hint">{hint}</span>}
    </div>
  );
}
