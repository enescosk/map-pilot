import type { TelemetryState } from "../types/telemetry";

export function VehicleTopView({ vehicle }: { vehicle: TelemetryState["vehicle"] }) {
  const brakeActive = Number(vehicle.brakePercent || 0) > 0 || Number(vehicle.brakePressure || 0) > 0.2 || Boolean(vehicle.handbrake);
  const hazardActive = Boolean(vehicle.emergency) || (Boolean(vehicle.leftSignal) && Boolean(vehicle.rightSignal));

  return (
    <section className="vehicle-visual-card" aria-label="Vehicle signal visualization">
      <div className="vehicle-stage">
        <div className="vehicle-body">
          <div className="vehicle-shadow" />
          <div className="wheel front-left" />
          <div className="wheel front-right" />
          <div className="wheel rear-left" />
          <div className="wheel rear-right" />
          <div className="side-mirror left" />
          <div className="side-mirror right" />
          <div className="vehicle-shell">
            <div className={vehicle.ignition ? "headlight left active" : "headlight left"} />
            <div className={vehicle.ignition ? "headlight right active" : "headlight right"} />
            <div className={vehicle.leftSignal || hazardActive ? "corner-signal front-left active" : "corner-signal front-left"} />
            <div className={vehicle.rightSignal || hazardActive ? "corner-signal front-right active" : "corner-signal front-right"} />
            <div className={vehicle.leftSignal || hazardActive ? "corner-signal rear-left active" : "corner-signal rear-left"} />
            <div className={vehicle.rightSignal || hazardActive ? "corner-signal rear-right active" : "corner-signal rear-right"} />
            <div className="hood-lines" />
            <div className="vehicle-windshield front" />
            <div className="vehicle-roof" />
            <div className="vehicle-windshield rear" />
            <div className="trunk-lines" />
            <div className={brakeActive ? "brake-light left active" : "brake-light left"} />
            <div className={brakeActive ? "brake-light right active" : "brake-light right"} />
          </div>
        </div>
      </div>
      <div className="vehicle-light-strip">
        <span className={vehicle.leftSignal || hazardActive ? "lamp active amber" : "lamp amber"}>LEFT</span>
        <span className={brakeActive ? "lamp active red" : "lamp red"}>BRAKE</span>
        <span className={hazardActive ? "lamp active red" : "lamp red"}>HAZARD</span>
        <span className={vehicle.rightSignal || hazardActive ? "lamp active amber" : "lamp amber"}>RIGHT</span>
      </div>
    </section>
  );
}
