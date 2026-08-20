import { describe, expect, it } from "vitest";
import { planLandmark } from "./landmarks";
import { roadPoint } from "./procedural";
import { groundHeight } from "./world";

describe("groundHeight", () => {
  it("matches the road center throughout the generated route", () => {
    for (const distance of [0, 180, 640, 1400]) {
      expect(groundHeight(distance, 0)).toBeCloseTo(roadPoint(distance).y, 8);
    }
  });

  it("keeps the shoulder below the asphalt and joins terrain without a raised seam", () => {
    const distance = 420;
    const road = groundHeight(distance, 2.7);
    const shoulder = groundHeight(distance, 3.2);
    const terrainEdge = groundHeight(distance, 3.501);

    expect(shoulder).toBeLessThan(road);
    expect(terrainEdge).toBeLessThan(road);
    expect(Math.abs(terrainEdge - shoulder)).toBeLessThan(0.08);
  });

  it("samples finite terrain heights on both sides of the road", () => {
    expect(Number.isFinite(groundHeight(875, -18))).toBe(true);
    expect(Number.isFinite(groundHeight(875, 18))).toBe(true);
  });

  it("keeps the riding surface intact while carving a river beneath a bridge", () => {
    const bridge = Array.from({ length: 8 }, (_, slot) => planLandmark(slot))
      .find((plan) => plan?.kind === "bridge");

    expect(bridge?.kind).toBe("bridge");
    if (!bridge || bridge.kind !== "bridge") return;

    const roadY = roadPoint(bridge.center).y;
    expect(groundHeight(bridge.center, 0)).toBeCloseTo(roadY, 8);
    expect(groundHeight(bridge.center, 12)).toBeLessThan(roadY - bridge.gorgeDepth * 0.55);
  });
});
