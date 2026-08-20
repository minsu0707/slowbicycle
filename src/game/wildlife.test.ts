import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { mulberry32 } from "./procedural";
import type { EndlessWorld } from "./world";
import {
  AMBIENT_FLOCK_TARGET,
  ANIMAL_CAPS,
  ENCOUNTER_CAPS,
  FIRST_SPAWN_RANGE,
  SPAWN_AHEAD_RANGE,
  SPAWN_INTERVAL_RANGE,
  WildlifeDirector,
  ambientFlockMotionParams,
  birdFlightPose,
  clamp01,
  computeFacingYaw,
  dampAngle,
  firstSpawnDelay,
  flockMotionParams,
  groundMotionParams,
  groundProgress,
  isFarEnough,
  nextSpawnDelay,
  pickSide,
  pickSpecies,
  pickWeighted,
  quadrupedPose,
  rabbitPose,
  smoothEase,
  spawnAheadOffset,
  speciesWeights,
  type SpeciesId,
} from "./wildlife";

/** Minimal EndlessWorld stand-in: a straight road along -Z, lateral = world X. */
function fakeWorld(): EndlessWorld {
  return {
    roadHalfWidth: () => 2.7,
    groundPosition: (distance: number, lateral: number, target: THREE.Vector3) => {
      target.set(lateral, 0, -distance);
      return target;
    },
  } as unknown as EndlessWorld;
}

describe("scheduling ranges", () => {
  it("keeps delays within their documented bounds", () => {
    const random = mulberry32(1);
    for (let i = 0; i < 300; i += 1) {
      const first = firstSpawnDelay(random);
      expect(first).toBeGreaterThanOrEqual(FIRST_SPAWN_RANGE.min);
      expect(first).toBeLessThanOrEqual(FIRST_SPAWN_RANGE.max);

      const next = nextSpawnDelay(random);
      expect(next).toBeGreaterThanOrEqual(SPAWN_INTERVAL_RANGE.min);
      expect(next).toBeLessThanOrEqual(SPAWN_INTERVAL_RANGE.max);

      const ahead = spawnAheadOffset(random);
      expect(ahead).toBeGreaterThanOrEqual(SPAWN_AHEAD_RANGE.min);
      expect(ahead).toBeLessThanOrEqual(SPAWN_AHEAD_RANGE.max);
    }
  });
});

describe("clamp01 / smoothEase", () => {
  it("clamps to [0, 1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
  });

  it("eases smoothly between clamped endpoints", () => {
    expect(smoothEase(-1)).toBe(0);
    expect(smoothEase(0)).toBe(0);
    expect(smoothEase(1)).toBe(1);
    expect(smoothEase(2)).toBe(1);
    expect(smoothEase(0.5)).toBeCloseTo(0.5, 8);
  });
});

describe("computeFacingYaw", () => {
  it("falls back to the previous yaw when the displacement is negligible", () => {
    expect(computeFacingYaw(0, 0, 1.23)).toBe(1.23);
  });

  it("matches the atan2(-dx, -dz) convention the road sampler uses", () => {
    expect(computeFacingYaw(0, -1, 0)).toBeCloseTo(0, 8);
    expect(computeFacingYaw(1, 0, 0)).toBeCloseTo(-Math.PI / 2, 8);
  });
});

describe("natural motion poses", () => {
  it("smooths yaw across the -pi/pi seam without taking the long turn", () => {
    const current = Math.PI - 0.02;
    const next = dampAngle(current, -Math.PI + 0.02, 8, 0.1);
    expect(Math.abs(next - current)).toBeLessThan(0.04);
  });

  it("uses opposing diagonal legs and articulated knees for quadrupeds", () => {
    const deer = quadrupedPose("deer", Math.PI / 2);
    const fox = quadrupedPose("fox", Math.PI / 2);
    expect(deer.legSwing[0]).toBeCloseTo(deer.legSwing[3], 8);
    expect(deer.legSwing[1]).toBeCloseTo(deer.legSwing[2], 8);
    expect(Math.sign(deer.legSwing[0])).toBe(-Math.sign(deer.legSwing[1]));
    expect(fox.legSwing[0]).toBeGreaterThan(deer.legSwing[0]);
    expect(deer.kneeBend.every((value) => value >= 0)).toBe(true);
  });

  it("gives rabbits a grounded takeoff and birds a flap-to-glide envelope", () => {
    expect(rabbitPose(0).lift).toBeCloseTo(0, 8);
    expect(rabbitPose(Math.PI / 2).lift).toBeGreaterThan(0.14);

    const flap = birdFlightPose(Math.PI / 2, -Math.PI / 2);
    const glide = birdFlightPose(Math.PI / 2, Math.PI / 2);
    expect(flap.wing).toBeGreaterThan(glide.wing);
    expect([flap, glide].every((pose) => Object.values(pose).every(Number.isFinite))).toBe(true);
  });
});

describe("isFarEnough", () => {
  it("rejects a candidate too close to an existing position", () => {
    expect(isFarEnough(10, [12], 5)).toBe(false);
  });

  it("accepts a candidate clear of every existing position", () => {
    expect(isFarEnough(10, [30, -20], 5)).toBe(true);
  });

  it("treats an empty list as always far enough", () => {
    expect(isFarEnough(10, [], 100)).toBe(true);
  });
});

describe("speciesWeights", () => {
  it("never lets a species reach zero at either end of the night range", () => {
    for (const n of [0, 1]) {
      const weights = speciesWeights(n);
      for (const weight of Object.values(weights)) expect(weight).toBeGreaterThan(0);
    }
  });

  it("shifts deer/fox up and bird/rabbit down as night falls", () => {
    const day = speciesWeights(0);
    const night = speciesWeights(1);
    expect(night.deer).toBeGreaterThan(day.deer);
    expect(night.fox).toBeGreaterThan(day.fox);
    expect(night.bird).toBeLessThan(day.bird);
    expect(night.rabbit).toBeLessThan(day.rabbit);
  });
});

describe("pickWeighted / pickSpecies", () => {
  it("distributes picks roughly in proportion to equal weights", () => {
    const random = mulberry32(123);
    const counts: Record<SpeciesId, number> = { bird: 0, deer: 0, fox: 0, rabbit: 0, squirrel: 0, sheep: 0 };
    const weights: Record<SpeciesId, number> = { bird: 1, deer: 1, fox: 1, rabbit: 1, squirrel: 1, sheep: 1 };
    const trials = 6000;
    for (let i = 0; i < trials; i += 1) counts[pickWeighted(random, weights)] += 1;
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(trials * (1 / 6) * 0.8);
      expect(count).toBeLessThan(trials * (1 / 6) * 1.2);
    }
  });

  it("still produces every species at full night, just biased toward dusk/night animals", () => {
    const random = mulberry32(456);
    const counts: Record<SpeciesId, number> = { bird: 0, deer: 0, fox: 0, rabbit: 0, squirrel: 0, sheep: 0 };
    const trials = 3000;
    for (let i = 0; i < trials; i += 1) counts[pickSpecies(random, 1)] += 1;
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);
    expect(counts.deer + counts.fox).toBeGreaterThan(trials * 0.5);
  });
});

describe("pickSide", () => {
  it("splits roughly evenly between the two sides of the road", () => {
    const random = mulberry32(9);
    let left = 0;
    let right = 0;
    for (let i = 0; i < 1000; i += 1) (pickSide(random) === -1 ? left += 1 : right += 1);
    expect(left).toBeGreaterThan(350);
    expect(right).toBeGreaterThan(350);
  });
});

describe("groundMotionParams", () => {
  it("keeps fox and rabbit off the paved road at the end of their path", () => {
    const random = mulberry32(11);
    for (let i = 0; i < 200; i += 1) {
      const fox = groundMotionParams("fox", 2.7, random);
      expect(Math.abs(fox.lateralEnd)).toBeGreaterThanOrEqual(2.7 - 1e-9);
      const rabbit = groundMotionParams("rabbit", 2.7, random);
      expect(Math.abs(rabbit.lateralEnd)).toBeGreaterThanOrEqual(2.7 - 1e-9);
    }
  });

  it("lets deer sometimes cross to the opposite shoulder and sometimes stay put", () => {
    const random = mulberry32(3);
    let crossed = false;
    let stayed = false;
    for (let i = 0; i < 150; i += 1) {
      const deer = groundMotionParams("deer", 2.7, random);
      if (Math.sign(deer.lateralEnd) !== Math.sign(deer.lateralStart)) crossed = true;
      else stayed = true;
    }
    expect(crossed).toBe(true);
    expect(stayed).toBe(true);
  });
});

describe("flockMotionParams", () => {
  it("sweeps birds from one side of the sky to the other, within the altitude band", () => {
    const random = mulberry32(4);
    for (let i = 0; i < 50; i += 1) {
      const params = flockMotionParams(random);
      expect(Math.sign(params.lateralEnd)).toBe(-Math.sign(params.lateralStart));
      expect(params.altitude).toBeGreaterThanOrEqual(14);
      expect(params.altitude).toBeLessThanOrEqual(30);
    }
  });
});

describe("ambientFlockMotionParams", () => {
  it("keeps ambient flocks close and low, unlike the wide, high encounter sweep", () => {
    const random = mulberry32(5);
    for (let i = 0; i < 50; i += 1) {
      const params = ambientFlockMotionParams(random);
      expect(Math.abs(params.lateralStart)).toBeLessThanOrEqual(20);
      expect(params.altitude).toBeGreaterThanOrEqual(6);
      expect(params.altitude).toBeLessThanOrEqual(12);
    }
  });
});

describe("groundProgress", () => {
  it("holds still through the initial pause, then eases exactly like smoothEase on the remainder", () => {
    expect(groundProgress(0)).toBe(0);
    expect(groundProgress(0.05)).toBe(0);
    expect(groundProgress(1)).toBeCloseTo(1, 8);
    expect(groundProgress(0.56)).toBeCloseTo(smoothEase((0.56 - 0.12) / 0.88), 8);
  });
});

describe("WildlifeDirector ambient flocks", () => {
  it("keeps birds flying overhead immediately, independent of the encounter spawn window", () => {
    const director = new WildlifeDirector(fakeWorld(), mulberry32(13));
    director.update(0.016, 0, 0);
    expect(director.ambientGroup.children.length).toBe(AMBIENT_FLOCK_TARGET.high);
    // The rare-encounter group is untouched by ambient flocks and keeps its own cap.
    expect(director.group.children.length).toBeLessThanOrEqual(ENCOUNTER_CAPS.high);
  });

  it("keeps replacing ambient flocks over a long ride, but leaves a quiet gap between them rather than an instant swap", () => {
    const director = new WildlifeDirector(fakeWorld(), mulberry32(29));
    let distance = 0;
    let sawFlock = false;
    let sawGap = false;
    for (let i = 0; i < 3000; i += 1) {
      distance += 0.3;
      director.update(0.05, distance, 0);
      const count = director.ambientGroup.children.length;
      expect(count).toBeLessThanOrEqual(AMBIENT_FLOCK_TARGET.high);
      if (count > 0) sawFlock = true;
      else sawFlock && (sawGap = true);
    }
    expect(sawFlock).toBe(true);
    expect(sawGap).toBe(true);
  });

  it("clears ambient flocks on reset and refills them on the next update", () => {
    const director = new WildlifeDirector(fakeWorld(), mulberry32(41));
    director.update(0.016, 0, 0);
    director.reset();
    expect(director.ambientGroup.children.length).toBe(0);
    director.update(0.016, 0, 0);
    expect(director.ambientGroup.children.length).toBe(AMBIENT_FLOCK_TARGET.high);
  });
});

describe("WildlifeDirector", () => {
  it("does not spawn before the documented first-spawn window", () => {
    const random = mulberry32(7);
    const director = new WildlifeDirector(fakeWorld(), random);
    const stepSeconds = 0.05;
    let elapsed = 0;
    while (elapsed < FIRST_SPAWN_RANGE.min - stepSeconds) {
      director.update(stepSeconds, 0, 0);
      expect(director.group.children.length).toBe(0);
      elapsed += stepSeconds;
    }
  });

  it("respects the concurrent-encounter cap over an extended ride", () => {
    const random = mulberry32(7);
    const director = new WildlifeDirector(fakeWorld(), random);
    let distance = 0;
    let sawSpawn = false;
    for (let i = 0; i < 1000; i += 1) {
      distance += 0.4;
      director.update(0.05, distance, 0);
      if (director.group.children.length > 0) sawSpawn = true;
      expect(director.group.children.length).toBeLessThanOrEqual(ENCOUNTER_CAPS.high);
    }
    expect(sawSpawn).toBe(true);
  });

  it("despawns encounters once the rider has passed far beyond them", () => {
    const random = mulberry32(99);
    const director = new WildlifeDirector(fakeWorld(), random);
    let spawned = false;
    for (let i = 0; i < 200 && !spawned; i += 1) {
      director.update(0.1, 0, 0);
      spawned = director.group.children.length > 0;
    }
    expect(spawned).toBe(true);

    // Jump the rider far down the road — every encounter's trailing-distance
    // despawn rule should fire regardless of when it was spawned.
    for (let i = 0; i < 10; i += 1) director.update(0.1, 100_000, 0);
    expect(director.group.children.length).toBe(0);
  });

  it("reset clears every active encounter and rearms the spawn timer", () => {
    const random = mulberry32(55);
    const director = new WildlifeDirector(fakeWorld(), random);
    let sawSpawn = false;
    for (let i = 0; i < 200; i += 1) {
      director.update(0.1, 0, 0);
      if (director.group.children.length > 0) sawSpawn = true;
    }
    expect(sawSpawn).toBe(true);

    director.reset();
    expect(director.group.children.length).toBe(0);

    // Immediately after reset, the first-spawn window applies again.
    director.update(FIRST_SPAWN_RANGE.min - 0.1, 0, 0);
    expect(director.group.children.length).toBe(0);
  });

  it("accepts quality changes without throwing and keeps caps distinct", () => {
    expect(ENCOUNTER_CAPS.low).toBeLessThan(ENCOUNTER_CAPS.high);
    expect(ANIMAL_CAPS.low).toBeLessThan(ANIMAL_CAPS.high);

    const director = new WildlifeDirector(fakeWorld(), mulberry32(3));
    expect(() => director.setQuality("low")).not.toThrow();
    expect(() => director.update(0.1, 0, 0)).not.toThrow();
  });

  it("keeps every animal transform finite across a long, varied run", () => {
    const random = mulberry32(21);
    const director = new WildlifeDirector(fakeWorld(), random);
    let distance = 0;
    for (let i = 0; i < 1500; i += 1) {
      distance += 0.3;
      director.update(0.05, distance, i % 500 < 250 ? 0 : 1);
      director.group.traverse((object) => {
        expect(Number.isFinite(object.position.x)).toBe(true);
        expect(Number.isFinite(object.position.y)).toBe(true);
        expect(Number.isFinite(object.position.z)).toBe(true);
        expect(Number.isFinite(object.rotation.y)).toBe(true);
      });
    }
  });
});
