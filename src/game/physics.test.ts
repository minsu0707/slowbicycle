import { describe, expect, it } from "vitest";
import { DEFAULT_BIKE_STATE, ROAD_RETURN_LIMIT, returnToRoadIfNeeded, speedKmh, stepBike } from "./physics";

describe("bike physics", () => {
  it("accelerates while pedaling and never reverses", () => {
    let state = { ...DEFAULT_BIKE_STATE };
    for (let i = 0; i < 120; i += 1) {
      state = stepBike(state, { pedal: 1, brake: 0, steer: 0 }, { slope: 0, offRoad: false }, 1 / 60);
    }
    expect(state.speed).toBeGreaterThan(5);
    expect(state.distance).toBeGreaterThan(4);

    for (let i = 0; i < 300; i += 1) {
      state = stepBike(state, { pedal: 0, brake: 1, steer: 0 }, { slope: 0, offRoad: false }, 1 / 60);
    }
    expect(state.speed).toBe(0);
  });

  it("loses speed uphill and gains it downhill", () => {
    const cruising = { ...DEFAULT_BIKE_STATE, speed: 8 };
    const uphill = stepBike(cruising, { pedal: 0.5, brake: 0, steer: 0 }, { slope: 0.12, offRoad: false }, 0.05);
    const downhill = stepBike(cruising, { pedal: 0.5, brake: 0, steer: 0 }, { slope: -0.12, offRoad: false }, 0.05);
    expect(uphill.speed).toBeLessThan(cruising.speed);
    expect(downhill.speed).toBeGreaterThan(uphill.speed);
  });

  it("makes off-road riding slower", () => {
    const cruising = { ...DEFAULT_BIKE_STATE, speed: 7 };
    const road = stepBike(cruising, { pedal: 0.4, brake: 0, steer: 0 }, { slope: 0, offRoad: false }, 0.05);
    const grass = stepBike(cruising, { pedal: 0.4, brake: 0, steer: 0 }, { slope: 0, offRoad: true }, 0.05);
    expect(grass.speed).toBeLessThan(road.speed);
  });

  it("coordinates steering direction with a restrained road-bike lean", () => {
    const cruising = { ...DEFAULT_BIKE_STATE, speed: 10 };
    const right = stepBike(cruising, { pedal: 0, brake: 0, steer: 1 }, { slope: 0, offRoad: false }, 0.05);

    expect(right.heading).toBeGreaterThan(0);
    expect(right.lateral).toBeGreaterThan(0);
    expect(right.lean).toBeLessThan(0);
    expect(Math.abs(right.lean)).toBeLessThan(0.2);
  });

  it("allows a generous off-road margin before returning to the road", () => {
    const exploring = { ...DEFAULT_BIKE_STATE, speed: 10, lateral: ROAD_RETURN_LIMIT, heading: 0.18, lean: -0.15 };

    expect(returnToRoadIfNeeded(exploring)).toBe(exploring);
  });

  it("returns an escaped bicycle to the road without losing ride progress", () => {
    const escaped = {
      ...DEFAULT_BIKE_STATE,
      speed: 10,
      distance: 642,
      lateral: -(ROAD_RETURN_LIMIT + 0.01),
      heading: -0.2,
      lean: 0.16,
      stamina: 0.72,
    };

    expect(returnToRoadIfNeeded(escaped)).toEqual({
      ...escaped,
      speed: 6.5,
      lateral: 0,
      heading: 0,
      lean: 0,
    });
  });

  it("converts meters per second to kilometers per hour", () => {
    expect(speedKmh(10)).toBe(36);
  });
});
