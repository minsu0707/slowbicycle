import { describe, expect, it } from "vitest";
import { mulberry32, roadPoint, seededNoise } from "./procedural";

describe("procedural world", () => {
  it("keeps the road continuous and moving forward", () => {
    const first = roadPoint(100);
    const next = roadPoint(100.5);

    expect(next.distanceTo(first)).toBeLessThan(1);
    expect(next.z).toBeLessThan(first.z);
  });

  it("generates deterministic scenery", () => {
    const first = mulberry32(42);
    const second = mulberry32(42);

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(seededNoise(12, 34)).toBe(seededNoise(12, 34));
  });
});
