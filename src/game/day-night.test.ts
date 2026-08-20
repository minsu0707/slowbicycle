import { describe, expect, it } from "vitest";
import { DAY_NIGHT_CYCLE_SECONDS, sampleAtmosphere } from "./day-night";

describe("day-night atmosphere", () => {
  it("loops after one eight-minute ride cycle", () => {
    const start = sampleAtmosphere(0);
    const looped = sampleAtmosphere(DAY_NIGHT_CYCLE_SECONDS);

    expect(looped.progress).toBeCloseTo(start.progress, 8);
    expect(looped.background).toBe(start.background);
  });

  it("moves from bright daylight into a darker starry night", () => {
    const day = sampleAtmosphere(60);
    const night = sampleAtmosphere(270);

    expect(day.starOpacity).toBe(0);
    expect(night.starOpacity).toBeGreaterThan(0.8);
    expect(night.ambientIntensity).toBeLessThan(day.ambientIntensity);
    expect(night.exposure).toBeLessThan(day.exposure);
  });

  it("puts the moon opposite the sun, so it rises as the sun sets", () => {
    const sample = sampleAtmosphere(180);
    expect(sample.moonElevation).toBeCloseTo(-sample.sunElevation, 8);
    expect(Math.cos(sample.moonAzimuth - sample.sunAzimuth)).toBeCloseTo(-1, 8);
  });
});
