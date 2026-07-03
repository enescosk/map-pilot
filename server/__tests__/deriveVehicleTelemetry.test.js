import { describe, it, expect } from "vitest";
import {
  speedFromTwist,
  steeringAngleFromYaw,
  rpmFromSpeed,
  pedalsFromAccel,
  turnIntentFromSteering,
  headingRateDps,
  turnIntentFromHeadingRate,
  createVehicleDeriver,
} from "../sources/deriveVehicleTelemetry.js";

describe("speedFromTwist", () => {
  it("returns hypot of x/y (ground speed)", () => {
    expect(speedFromTwist({ x: 3, y: 4 })).toBeCloseTo(5);
  });
  it("ignores z and treats missing as 0", () => {
    expect(speedFromTwist({ x: 6.94, z: 99 })).toBeCloseTo(6.94);
    expect(speedFromTwist(null)).toBe(0);
  });
});

describe("steeringAngleFromYaw", () => {
  it("is 0 below the minimum speed (noise guard)", () => {
    expect(steeringAngleFromYaw(0.3, 0.2)).toBe(0);
  });
  it("turns right (positive) for positive yaw rate while moving", () => {
    const deg = steeringAngleFromYaw(0.2, 6.94);
    expect(deg).toBeGreaterThan(0);
    expect(deg).toBeLessThan(10);
  });
  it("clamps to the believable max", () => {
    expect(steeringAngleFromYaw(50, 5)).toBeLessThanOrEqual(35);
    expect(steeringAngleFromYaw(-50, 5)).toBeGreaterThanOrEqual(-35);
  });
});

describe("rpmFromSpeed", () => {
  it("is 0 at standstill", () => {
    expect(rpmFromSpeed(0)).toBe(0);
  });
  it("scales with speed", () => {
    expect(rpmFromSpeed(6.94)).toBeGreaterThan(rpmFromSpeed(3));
  });
});

describe("pedalsFromAccel", () => {
  it("maps positive accel to throttle, zero brake", () => {
    const p = pedalsFromAccel(1.0);
    expect(p.throttlePercent).toBeGreaterThan(0);
    expect(p.brakePercent).toBe(0);
  });
  it("maps negative accel to brake, zero throttle", () => {
    const p = pedalsFromAccel(-1.5);
    expect(p.brakePercent).toBeGreaterThan(0);
    expect(p.throttlePercent).toBe(0);
  });
  it("returns zeros inside the deadband", () => {
    expect(pedalsFromAccel(0.05)).toEqual({ throttlePercent: 0, brakePercent: 0 });
  });
});

describe("turnIntentFromSteering", () => {
  it("is null inside the deadband", () => {
    expect(turnIntentFromSteering(0)).toBeNull();
    expect(turnIntentFromSteering(5)).toBeNull();
  });
  it("reads positive steering as a right turn, negative as left", () => {
    expect(turnIntentFromSteering(18)).toBe("right");
    expect(turnIntentFromSteering(-18)).toBe("left");
  });
});

describe("headingRateDps", () => {
  it("computes a simple positive rate", () => {
    expect(headingRateDps(100, 110, 1)).toBeCloseTo(10);
  });
  it("is wrap-safe across 0/360 (359 -> 1 is +2, not -358)", () => {
    expect(headingRateDps(359, 1, 1)).toBeCloseTo(2);
    expect(headingRateDps(1, 359, 1)).toBeCloseTo(-2);
  });
  it("returns 0 for non-positive dt", () => {
    expect(headingRateDps(10, 50, 0)).toBe(0);
  });
});

describe("turnIntentFromHeadingRate", () => {
  it("is null below the rate threshold", () => {
    expect(turnIntentFromHeadingRate(3)).toBeNull();
  });
  it("reads increasing heading (clockwise) as a right turn", () => {
    expect(turnIntentFromHeadingRate(20)).toBe("right");
    expect(turnIntentFromHeadingRate(-20)).toBe("left");
  });
});

describe("createVehicleDeriver heading-driven signals", () => {
  // Real bags: steering angle stays tiny (a few degrees) through a wide turn, but
  // heading sweeps. The blinker must light off heading rate, not steering.
  function step(d, heading, t) {
    d.update("/heading", "std_msgs/Float64", { data: heading }, t);
    return d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, t);
  }

  it("lights the right blinker when heading sweeps clockwise, despite ~0 steering", () => {
    const d = createVehicleDeriver();
    step(d, 100, 0);
    step(d, 115, 500);   // +30 deg/s — well past threshold
    const p = step(d, 130, 1000);
    expect(p.vehicle.rightSignal).toBe(true);
    expect(p.vehicle.leftSignal).toBe(false);
  });

  it("lights the left blinker when heading sweeps counter-clockwise", () => {
    const d = createVehicleDeriver();
    step(d, 200, 0);
    step(d, 185, 500);
    const p = step(d, 170, 1000);
    expect(p.vehicle.leftSignal).toBe(true);
    expect(p.vehicle.rightSignal).toBe(false);
  });

  it("stays dark when heading holds steady (driving straight)", () => {
    const d = createVehicleDeriver();
    step(d, 90, 0);
    step(d, 90.5, 500);
    const p = step(d, 91, 1000);
    expect(p.vehicle.leftSignal).toBe(false);
    expect(p.vehicle.rightSignal).toBe(false);
  });
});

describe("createVehicleDeriver turn signals", () => {
  // Drive the deriver at a fixed speed with a yaw rate strong enough to push
  // steeringAngle past the signal threshold, stepping time forward by hand.
  function turn(d, yaw, t) {
    d.update("/imu/data", "sensor_msgs/Imu", { angular_velocity: { z: yaw } });
    return d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 6, y: 0 } } } }, t);
  }

  it("does not light the blinker for a brief steering blip (< hold time)", () => {
    const d = createVehicleDeriver();
    const p = turn(d, 0.9, 0); // strong right yaw, but only one sample at t=0
    expect(p.vehicle.rightSignal).toBe(false);
    expect(p.vehicle.leftSignal).toBe(false);
  });

  it("lights the right blinker once the turn is held past the hold time", () => {
    const d = createVehicleDeriver();
    turn(d, 0.9, 0);
    turn(d, 0.9, 200);
    const p = turn(d, 0.9, 400); // intent held >= signalHoldMs (350ms)
    expect(p.vehicle.rightSignal).toBe(true);
    expect(p.vehicle.leftSignal).toBe(false);
  });

  it("keeps the blinker on briefly after the wheel re-centers (release window)", () => {
    const d = createVehicleDeriver();
    turn(d, 0.9, 0);
    turn(d, 0.9, 400); // lit (held past hold time)
    // wheel centers — yaw ~0 — but still within signalReleaseMs
    d.update("/imu/data", "imu", { angular_velocity: { z: 0 } });
    const soon = d.ingest("/gnss_1/velocity", "twist", { twist: { twist: { linear: { x: 6, y: 0 } } } }, 500);
    expect(soon.vehicle.rightSignal).toBe(true);
    // well past the release window — blinker drops
    d.update("/imu/data", "imu", { angular_velocity: { z: 0 } });
    const later = d.ingest("/gnss_1/velocity", "twist", { twist: { twist: { linear: { x: 6, y: 0 } } } }, 1600);
    expect(later.vehicle.rightSignal).toBe(false);
  });
});

describe("createVehicleDeriver", () => {
  it("returns null until a speed sample arrives", () => {
    const d = createVehicleDeriver();
    expect(d.ingest("/imu/data", "sensor_msgs/Imu", { angular_velocity: { z: 0.1 } }, 1000)).toBeNull();
  });

  it("emits a synthetic vehicle patch once speed is known", () => {
    const d = createVehicleDeriver();
    d.ingest("/imu/data", "sensor_msgs/Imu", { angular_velocity: { z: 0.2 }, linear_acceleration: { x: 1.0 } }, 0);
    const patch = d.ingest(
      "/gnss_1/velocity",
      "geometry_msgs/TwistWithCovarianceStamped",
      { twist: { twist: { linear: { x: 6.94, y: 0 } } } },
      1000,
    );
    expect(patch).not.toBeNull();
    expect(patch.synthetic).toBe(true);
    expect(patch.vehicle.synthetic).toBe(true);
    expect(patch.vehicle.speedKmh).toBeCloseTo(25, 0);
    expect(patch.speed).toBeCloseTo(6.94, 1);
    expect(patch.vehicle.steeringAngle).toBeGreaterThan(0);
    expect(patch.vehicle.throttlePedalPercent).toBeGreaterThan(0);
    expect(patch.vehicle.rpm).toBeGreaterThan(0);
  });

  it("throttles output to the configured interval", () => {
    const d = createVehicleDeriver();
    const first = d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 0);
    const tooSoon = d.ingest("/imu/data", "imu", { angular_velocity: { z: 0 } }, 10);
    const later = d.ingest("/imu/data", "imu", { angular_velocity: { z: 0 } }, 200);
    expect(first).not.toBeNull();
    expect(tooSoon).toBeNull();
    expect(later).not.toBeNull();
  });

  it("passes heading through when available", () => {
    const d = createVehicleDeriver();
    d.ingest("/heading", "std_msgs/Float64", { data: 78.2 }, 0);
    const patch = d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 1000);
    expect(patch.heading).toBeCloseTo(78.2, 1);
  });

  it("keeps updating speed from odometry when GNSS velocity goes stale", () => {
    const d = createVehicleDeriver();
    // GNSS velocity seen once, then stops publishing (mid-loop bag segment).
    d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 0);
    // Odometry keeps flowing with a *different*, changing speed. After the GNSS
    // freshness window it must take over instead of freezing at the last GNSS value.
    const patch = d.ingest(
      "/ekf/odometry_earth",
      "nav_msgs/Odometry",
      { twist: { twist: { linear: { x: 9, y: 0 } } } },
      2000,
    );
    expect(patch).not.toBeNull();
    expect(patch.speed).toBeCloseTo(9, 1); // odometry value, not the stale 5
  });

  it("prefers fresh GNSS velocity over odometry", () => {
    const d = createVehicleDeriver();
    d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 1000);
    // Odometry arrives while GNSS is still fresh — should be ignored.
    const patch = d.ingest(
      "/ekf/odometry_earth",
      "nav_msgs/Odometry",
      { twist: { twist: { linear: { x: 9, y: 0 } } } },
      1100,
    );
    expect(patch.speed).toBeCloseTo(5, 1); // GNSS value retained
  });
});
