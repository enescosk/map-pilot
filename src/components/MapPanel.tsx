import type { MapSummary } from "../App";

type MapPanelProps = {
  mapSummary: MapSummary;
  isMapping: boolean;
};

function MapPanel({ mapSummary, isMapping }: MapPanelProps) {
  return (
    <article className="panel map-panel">
      <div className="panel-heading">
        <p className="panel-label">Map</p>
        <h2>Coverage</h2>
      </div>

      <div className="map-preview" aria-label="Occupancy map preview">
        <div className="map-room large" />
        <div className="map-room medium" />
        <div className="map-room small" />
        <div className={isMapping ? "robot-marker scanning" : "robot-marker"} />
      </div>

      <div className="map-metrics">
        <span>{mapSummary.areaCovered} m2 covered</span>
        <span>{mapSummary.roomsDetected} rooms</span>
        <span>Loop closure: {mapSummary.loopClosure}</span>
        <span>Updated: {mapSummary.lastUpdated}</span>
      </div>
    </article>
  );
}

export default MapPanel;
