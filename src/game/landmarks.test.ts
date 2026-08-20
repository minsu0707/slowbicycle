import { describe, expect, it } from "vitest";
import {
  FIRST_LANDMARK_RANGE,
  MAX_LANDMARK_GAP,
  MIN_LANDMARK_GAP,
  SLOT_LENGTH,
  landmarkTerrainCarve,
  landmarksInRange,
  planLandmark,
  waterfallRoadClearance,
} from "./landmarks";

describe("procedural landmarks", () => {
  it("creates the same plan for the same slot", () => {
    expect(planLandmark(7)).toEqual(planLandmark(7));
    expect(planLandmark(-1)).toBeNull();
  });

  it("places the first landmark early in the ride", () => {
    const first = planLandmark(0);
    expect(first).not.toBeNull();
    expect(first?.center).toBeGreaterThanOrEqual(FIRST_LANDMARK_RANGE.min);
    expect(first?.center).toBeLessThanOrEqual(FIRST_LANDMARK_RANGE.max);
  });

  it("keeps successive landmarks varied and comfortably spaced", () => {
    const plans = Array.from({ length: 24 }, (_, slot) => planLandmark(slot));
    for (let index = 1; index < plans.length; index += 1) {
      const gap = (plans[index]?.center ?? 0) - (plans[index - 1]?.center ?? 0);
      expect(gap).toBeGreaterThanOrEqual(index === 1 ? MIN_LANDMARK_GAP - 160 : MIN_LANDMARK_GAP);
      expect(gap).toBeLessThanOrEqual(MAX_LANDMARK_GAP);
    }
    expect(new Set(plans.map((plan) => plan?.kind))).toEqual(new Set(["bridge", "waterfall"]));
  });

  it("returns only landmarks whose centres lie in the requested stretch", () => {
    const firstSlot = landmarksInRange(0, SLOT_LENGTH);
    expect(firstSlot).toHaveLength(1);
    expect(firstSlot[0]).toEqual(planLandmark(0));
    expect(landmarksInRange(-500, 0)).toHaveLength(0);
  });

  it("carves a bridge gorge without changing distant terrain", () => {
    const bridge = Array.from({ length: 6 }, (_, slot) => planLandmark(slot))
      .find((plan) => plan?.kind === "bridge");
    expect(bridge?.kind).toBe("bridge");
    if (!bridge || bridge.kind !== "bridge") return;

    const centre = landmarkTerrainCarve(bridge.center, 0);
    const outside = landmarkTerrainCarve(bridge.center + bridge.halfSpan + 2, 0);
    expect(centre.flatten).toBeGreaterThan(0.9);
    expect(centre.heightDelta).toBeLessThan(-bridge.gorgeDepth * 0.8);
    expect(outside).toMatchObject({ heightDelta: 0, flatten: 0 });
  });

  it("keeps every waterfall pool safely outside the road", () => {
    const waterfalls = Array.from({ length: 20 }, (_, slot) => planLandmark(slot))
      .filter((plan) => plan?.kind === "waterfall");
    expect(waterfalls.length).toBeGreaterThan(0);
    for (const plan of waterfalls) {
      if (!plan || plan.kind !== "waterfall") continue;
      expect(waterfallRoadClearance(plan)).toBeGreaterThanOrEqual(7.5);
      expect(landmarkTerrainCarve(plan.center, 0).flatten).toBe(0);
    }
  });
});
