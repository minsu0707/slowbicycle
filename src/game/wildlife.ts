import * as THREE from "three";
import type { EndlessWorld } from "./world";

// Randomly timed land/sky encounters along the route. Everything here moves in
// road-relative (distance, lateral) coordinates and goes through
// `world.groundPosition` for ground contact — the road curves (see
// `procedural.roadPoint`), so lerping raw world-space Vector3s would visibly
// cut through terrain on a bend. Facing direction is derived from each
// animal's own frame-to-frame displacement rather than reimplementing the
// road's tangent math, which keeps this file decoupled from `world.ts`'s
// curve internals.
//
// Every mesh below references a shared, module-level geometry/material (the
// same pattern `world.ts` uses for its tree/bush/rock materials) — spawning
// and despawning an encounter never allocates or disposes GPU resources, only
// Object3D wrapper objects.

export type SpeciesId = "bird" | "deer" | "fox" | "rabbit" | "squirrel" | "sheep";
export type GroundSpeciesId = "deer" | "fox" | "rabbit" | "squirrel" | "sheep";
export type Quality = "low" | "high";

export const SPAWN_INTERVAL_RANGE = { min: 10, max: 26 } as const;
export const FIRST_SPAWN_RANGE = { min: 5, max: 10 } as const;
export const SPAWN_AHEAD_RANGE = { min: 35, max: 75 } as const;
export const RETRY_DELAY_SECONDS = 4;
export const BEHIND_DESPAWN_DISTANCE = 20;
export const GROUND_MIN_GAP = 14;
export const FLOCK_MIN_GAP = 25;
export const ENCOUNTER_CAPS: Record<Quality, number> = { low: 2, high: 3 };
export const ANIMAL_CAPS: Record<Quality, number> = { low: 7, high: 14 };
/**
 * How many flocks always ride overhead, independent of the rare "encounter"
 * system above. These are the difference between "a flock crosses the sky
 * once a minute" and "there are birds up there" — always at least one in
 * view, close and low enough to actually notice while riding.
 */
export const AMBIENT_FLOCK_TARGET: Record<Quality, number> = { low: 1, high: 1 };
/** Below this fraction of animals are asleep; ambient flocks thin out but never fully vanish. */
const AMBIENT_NIGHT_CUTOFF = 0.82;
/** Quiet-sky gap between one ambient flock leaving and the next arriving — without it, a flock landing exactly as its predecessor expires reads as a conveyor belt instead of wildlife. */
export const AMBIENT_RESPAWN_GAP = { min: 8, max: 22 } as const;

// ---------------------------------------------------------------------------
// Pure scheduling / species helpers — no THREE, no side effects, easy to test.
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function randomInRange(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/** Delay before the very first encounter of a session/ride. */
export function firstSpawnDelay(random: () => number): number {
  return randomInRange(random, FIRST_SPAWN_RANGE.min, FIRST_SPAWN_RANGE.max);
}

/** Delay between subsequent encounters. */
export function nextSpawnDelay(random: () => number): number {
  return randomInRange(random, SPAWN_INTERVAL_RANGE.min, SPAWN_INTERVAL_RANGE.max);
}

/** How far ahead of the rider a new encounter appears — beyond most of the fog falloff, so it resolves in rather than popping. */
export function spawnAheadOffset(random: () => number): number {
  return randomInRange(random, SPAWN_AHEAD_RANGE.min, SPAWN_AHEAD_RANGE.max);
}

export function lifespanFor(species: SpeciesId, random: () => number): number {
  if (species === "bird") return randomInRange(random, 10, 16);
  // Sheep graze rather than flee — worth keeping in view longer than a
  // startled deer or a darting rabbit.
  if (species === "sheep") return randomInRange(random, 11, 18);
  return randomInRange(random, 8, 14);
}

export function pickSide(random: () => number): 1 | -1 {
  return random() < 0.5 ? -1 : 1;
}

/**
 * Species weights shift with `nightAmount` (deer/fox lean nocturnal, rabbit/bird
 * lean daylight) but every weight keeps a positive floor — the brief asks for
 * `nightAmount` to *influence* the mix, not to remove a species entirely.
 */
export function speciesWeights(nightAmount: number): Record<SpeciesId, number> {
  const n = clamp01(nightAmount);
  return {
    bird: lerpNum(1, 0.35, n),
    rabbit: lerpNum(1, 0.5, n),
    deer: lerpNum(0.55, 1, n),
    fox: lerpNum(0.35, 1.1, n),
    squirrel: lerpNum(0.85, 0.3, n),
    // Pastured sheep are asleep by night, but never fully gone — some
    // farms still show a dozing flock in the paddock after dark.
    sheep: lerpNum(0.7, 0.12, n),
  };
}

export function pickWeighted(random: () => number, weights: Record<SpeciesId, number>): SpeciesId {
  const entries = Object.entries(weights) as Array<[SpeciesId, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) return entries[0][0];
  let roll = random() * total;
  for (const [species, weight] of entries) {
    roll -= Math.max(0, weight);
    if (roll <= 0) return species;
  }
  return entries[entries.length - 1][0];
}

export function pickSpecies(random: () => number, nightAmount: number): SpeciesId {
  return pickWeighted(random, speciesWeights(nightAmount));
}

/** Bird flocks are the only "size varies with quality" case — low quality halves the count. */
export function flockSize(random: () => number, quality: Quality): number {
  const [min, max] = quality === "high" ? [5, 10] : [3, 6];
  return Math.round(randomInRange(random, min, max));
}

/** Ambient flocks stay small — a handful of birds passing over, not a wheeling swarm. */
export function ambientFlockSize(random: () => number, quality: Quality): number {
  const [min, max] = quality === "high" ? [3, 5] : [2, 3];
  return Math.round(randomInRange(random, min, max));
}

export function groupSize(species: GroundSpeciesId, random: () => number): number {
  if (species === "deer") return random() < 0.35 ? 2 : 1;
  if (species === "rabbit") return 1 + Math.floor(random() * 3);
  if (species === "squirrel") return random() < 0.25 ? 2 : 1;
  if (species === "sheep") return 2 + Math.floor(random() * 3); // a small grazing flock
  return 1; // fox: solitary
}

/** Keeps a value on its side of the paved road (fox/rabbit trot the shoulder, they don't enter the lane). */
function clampOffRoad(value: number, roadHalfWidth: number, side: 1 | -1): number {
  return side > 0 ? Math.max(value, roadHalfWidth) : Math.min(value, -roadHalfWidth);
}

export interface GroundMotionParams {
  lateralStart: number;
  lateralEnd: number;
  alongDrift: number;
  lifespan: number;
}

/** Per-species lateral path across the shoulder (and, for deer, sometimes the full road). */
export function groundMotionParams(
  species: GroundSpeciesId,
  roadHalfWidth: number,
  random: () => number,
): GroundMotionParams {
  const side = pickSide(random);
  const lifespan = lifespanFor(species, random);
  if (species === "deer") {
    const lateralStart = side * (roadHalfWidth + randomInRange(random, 3, 10));
    const crossing = random() < 0.6;
    const lateralEnd = crossing
      ? -lateralStart * randomInRange(random, 0.7, 1.1)
      : lateralStart + side * randomInRange(random, -2, 2);
    return { lateralStart, lateralEnd, alongDrift: randomInRange(random, 2, 6), lifespan };
  }
  if (species === "fox") {
    const lateralStart = side * (roadHalfWidth + randomInRange(random, 1.5, 5));
    const lateralEnd = clampOffRoad(lateralStart + side * randomInRange(random, -3, 3), roadHalfWidth, side);
    return { lateralStart, lateralEnd, alongDrift: randomInRange(random, 6, 14), lifespan };
  }
  if (species === "squirrel") {
    // A short, quick dart along the shoulder — over almost before it's noticed.
    const lateralStart = side * (roadHalfWidth + randomInRange(random, 0.5, 3));
    const lateralEnd = clampOffRoad(lateralStart + side * randomInRange(random, -2, 2), roadHalfWidth, side);
    return { lateralStart, lateralEnd, alongDrift: randomInRange(random, 3, 7), lifespan };
  }
  if (species === "sheep") {
    // Barely drifts — a grazing flock ambles rather than travels, and never
    // ventures toward the paved lane.
    const lateralStart = side * (roadHalfWidth + randomInRange(random, 2, 8));
    const lateralEnd = clampOffRoad(lateralStart + side * randomInRange(random, -1, 1), roadHalfWidth, side);
    return { lateralStart, lateralEnd, alongDrift: randomInRange(random, 0.5, 2), lifespan };
  }
  const lateralStart = side * (roadHalfWidth + randomInRange(random, 1, 4));
  const lateralEnd = clampOffRoad(lateralStart + side * randomInRange(random, -1.5, 1.5), roadHalfWidth, side);
  return { lateralStart, lateralEnd, alongDrift: randomInRange(random, 1, 4), lifespan };
}

export interface FlockMotionParams {
  lateralStart: number;
  lateralEnd: number;
  altitude: number;
  alongDrift: number;
  lifespan: number;
}

/** Birds sweep a wide chord across the sky, well clear of the road's own width. */
export function flockMotionParams(random: () => number): FlockMotionParams {
  const side = pickSide(random);
  const lateralStart = side * randomInRange(random, 40, 90);
  const lateralEnd = -lateralStart * randomInRange(random, 0.8, 1.2);
  return {
    lateralStart,
    lateralEnd,
    altitude: randomInRange(random, 14, 30),
    alongDrift: randomInRange(random, 30, 70),
    lifespan: lifespanFor("bird", random),
  };
}

/**
 * Ambient flocks trade the encounter flock's wide, distant sweep for a path
 * that stays close and low over the road — near enough that a small
 * silhouette against the sky is still easy to pick out while riding.
 */
export function ambientFlockMotionParams(random: () => number): FlockMotionParams {
  const side = pickSide(random);
  const lateralStart = side * randomInRange(random, 7, 20);
  const lateralEnd = -lateralStart * randomInRange(random, 0.6, 1.05);
  return {
    lateralStart,
    lateralEnd,
    altitude: randomInRange(random, 6, 12),
    alongDrift: randomInRange(random, 45, 90),
    lifespan: randomInRange(random, 16, 26),
  };
}

/**
 * A ground animal's progress needs a beat of stillness before it moves — real
 * wildlife notices an approaching rider and freezes for a moment before it
 * darts off, rather than gliding away the instant it appears. `smoothEase`
 * alone starts moving immediately; this holds at 0 through an initial pause,
 * then eases through the rest exactly as `smoothEase` would on its own.
 */
export function groundProgress(t: number): number {
  const clamped = clamp01(t);
  const pause = 0.12;
  if (clamped <= pause) return 0;
  return smoothEase((clamped - pause) / (1 - pause));
}

/** True when `candidate` keeps at least `minGap` from every other active encounter's current position — the collision-avoidance check between concurrent encounters. */
export function isFarEnough(candidate: number, others: number[], minGap: number): boolean {
  return others.every((other) => Math.abs(other - candidate) >= minGap);
}

/**
 * Facing yaw from a frame-to-frame world-space displacement. Mirrors
 * `EndlessWorld.sample`'s `atan2(-dx, -dz)` convention so a wildlife model
 * built facing -Z (matching the bicycle's own convention) orients correctly
 * without needing the road's tangent directly. Falls back to the previous
 * yaw when the displacement is too small to be meaningful (an animal paused
 * between hops), avoiding atan2(0, 0) jitter.
 */
export function computeFacingYaw(deltaX: number, deltaZ: number, fallback: number): number {
  if (deltaX * deltaX + deltaZ * deltaZ < 1e-8) return fallback;
  return Math.atan2(-deltaX, -deltaZ);
}

/** Smoothstep easing for an encounter's age/lifespan fraction. Pure, no THREE dependency. */
export function smoothEase(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * Math.max(0, dt)));
}

export interface QuadrupedPose {
  bodyBob: number;
  bodyPitch: number;
  headPitch: number;
  tailYaw: number;
  legSwing: [number, number, number, number];
  kneeBend: [number, number, number, number];
}

export function quadrupedPose(species: "deer" | "fox" | "sheep", phase: number): QuadrupedPose {
  const amplitude = species === "fox" ? 0.48 : species === "sheep" ? 0.22 : 0.34;
  const bob = species === "fox" ? 0.018 : species === "sheep" ? 0.014 : 0.026;
  const pitch = species === "fox" ? 0.035 : species === "sheep" ? 0.018 : 0.025;
  const tailAmplitude = species === "fox" ? 0.24 : species === "sheep" ? 0.05 : 0.09;
  const kneeAmplitude = species === "sheep" ? 0.26 : 0.42;
  const step = Math.sin(phase);
  const counter = Math.sin(phase + Math.PI);
  const liftA = Math.max(0, Math.sin(phase + Math.PI / 3));
  const liftB = Math.max(0, Math.sin(phase + Math.PI + Math.PI / 3));
  return {
    bodyBob: Math.abs(step) * bob,
    bodyPitch: Math.sin(phase * 2) * pitch,
    headPitch: -Math.sin(phase * 2) * 0.04,
    tailYaw: Math.sin(phase * 0.5) * tailAmplitude,
    legSwing: [step * amplitude, counter * amplitude, counter * amplitude, step * amplitude],
    kneeBend: [liftA * kneeAmplitude, liftB * kneeAmplitude, liftB * kneeAmplitude * 0.8, liftA * kneeAmplitude * 0.8],
  };
}

export interface RabbitPose {
  lift: number;
  bodyPitch: number;
  headPitch: number;
}

export function rabbitPose(phase: number): RabbitPose {
  const cycle = ((phase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const airborne = Math.max(0, Math.sin(cycle));
  return {
    lift: airborne * airborne * 0.16,
    bodyPitch: Math.sin(cycle) * 0.12 - Math.sin(cycle * 2) * 0.04,
    headPitch: -Math.sin(cycle) * 0.08,
  };
}

export interface BirdFlightPose {
  wing: number;
  lift: number;
  bodyPitch: number;
}

export function birdFlightPose(phase: number, glidePhase: number): BirdFlightPose {
  const glide = smoothEase((Math.sin(glidePhase) + 1) * 0.5);
  const flapEnvelope = 0.28 + (1 - glide) * 0.72;
  const stroke = Math.sin(phase) * flapEnvelope;
  return {
    wing: 0.12 + stroke * 0.82,
    lift: Math.max(0, -stroke) * 0.09 + Math.sin(glidePhase * 0.7) * 0.035,
    bodyPitch: -stroke * 0.035 + glide * 0.025,
  };
}

// ---------------------------------------------------------------------------
// Shared geometry/materials — module singletons, reused across every spawn.
// ---------------------------------------------------------------------------

const DEER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 1, flatShading: true });
const DEER_LIGHT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb89a70, roughness: 1, flatShading: true });
const DEER_TORSO_GEOMETRY = new THREE.SphereGeometry(1, 8, 6);
const DEER_HEAD_GEOMETRY = new THREE.SphereGeometry(1, 7, 5);
const DEER_NECK_GEOMETRY = new THREE.CylinderGeometry(0.105, 0.16, 0.48, 6);
const DEER_MUZZLE_GEOMETRY = new THREE.SphereGeometry(1, 6, 4);
const DEER_EAR_GEOMETRY = new THREE.ConeGeometry(0.05, 0.16, 4);
const DEER_TAIL_GEOMETRY = new THREE.ConeGeometry(0.05, 0.14, 5);
const DEER_UPPER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.04, 0.052, 0.3, 5);
const DEER_LOWER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.026, 0.035, 0.27, 5);

const FOX_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb5592f, roughness: 1, flatShading: true });
const FOX_DARK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x332720, roughness: 1, flatShading: true });
const FOX_LIGHT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd9c2a0, roughness: 1, flatShading: true });
const FOX_TORSO_GEOMETRY = new THREE.SphereGeometry(1, 8, 6);
const FOX_HEAD_GEOMETRY = new THREE.SphereGeometry(1, 7, 5);
const FOX_MUZZLE_GEOMETRY = new THREE.ConeGeometry(0.075, 0.22, 5);
const FOX_EAR_GEOMETRY = new THREE.ConeGeometry(0.045, 0.13, 4);
const FOX_TAIL_GEOMETRY = new THREE.SphereGeometry(1, 7, 5);
const FOX_UPPER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.025, 0.034, 0.16, 5);
const FOX_LOWER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.018, 0.024, 0.15, 5);

const RABBIT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 1, flatShading: true });
const RABBIT_BODY_GEOMETRY = new THREE.IcosahedronGeometry(0.17, 0);
const RABBIT_HEAD_GEOMETRY = new THREE.IcosahedronGeometry(0.1, 0);
const RABBIT_EAR_GEOMETRY = new THREE.ConeGeometry(0.03, 0.22, 4);
const RABBIT_TAIL_GEOMETRY = new THREE.IcosahedronGeometry(0.055, 0);
const RABBIT_HAUNCH_GEOMETRY = new THREE.SphereGeometry(1, 7, 5);

const SQUIRREL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8a6a49, roughness: 1, flatShading: true });
const SQUIRREL_LIGHT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd8c6a8, roughness: 1, flatShading: true });
const SQUIRREL_BODY_GEOMETRY = new THREE.IcosahedronGeometry(0.11, 0);
const SQUIRREL_HEAD_GEOMETRY = new THREE.IcosahedronGeometry(0.07, 0);
const SQUIRREL_EAR_GEOMETRY = new THREE.ConeGeometry(0.02, 0.05, 4);
// The tail is the whole point of a squirrel silhouette — big, and swept up
// and forward over the back rather than trailing behind like every other
// species here.
const SQUIRREL_TAIL_GEOMETRY = new THREE.IcosahedronGeometry(0.1, 0);

const SHEEP_WOOL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 1, flatShading: true });
const SHEEP_DARK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 1, flatShading: true });
const SHEEP_BODY_GEOMETRY = new THREE.IcosahedronGeometry(1, 1);
const SHEEP_HEAD_GEOMETRY = new THREE.IcosahedronGeometry(1, 0);
const SHEEP_EAR_GEOMETRY = new THREE.ConeGeometry(0.045, 0.1, 4);
const SHEEP_UPPER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.038, 0.045, 0.22, 5);
const SHEEP_LOWER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.03, 0.036, 0.16, 5);

// Birds read as small dark silhouettes against the sky — unlit is both cheaper
// and truer to how a distant flock actually looks. Double-sided: the wing and
// tail are thin, flat, single-sided planes, and a chase camera can end up
// looking at either face as a flock wheels overhead — front-face culling made
// wings vanish depending on viewing angle, which is what actually read as
// "broken" rather than the shape itself.
const BIRD_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x201f1c, fog: true, side: THREE.DoubleSide });
const BIRD_BODY_GEOMETRY = new THREE.SphereGeometry(1, 8, 6);
const BIRD_BEAK_GEOMETRY = new THREE.ConeGeometry(0.028, 0.09, 6);
// A tapered, swept quad rather than a three-point sliver — root wide against
// the body, tip pulled forward into a point — so the silhouette actually
// reads as a wing instead of a flat blade once the bird is big enough to
// make out its shape.
const BIRD_WING_GEOMETRY = new THREE.BufferGeometry();
BIRD_WING_GEOMETRY.setAttribute("position", new THREE.Float32BufferAttribute([
  0, 0, -0.055, 0, 0, 0.06, -0.38, 0, 0.095, -0.25, 0, -0.105,
], 3));
BIRD_WING_GEOMETRY.setIndex([0, 1, 2, 0, 2, 3]);
BIRD_WING_GEOMETRY.computeVertexNormals();
// A flat triangular fan, authored directly in the bird's own XZ plane and
// already pointing tailward (+Z) — no rotated-cone trick, which previously
// scaled the cone's own length down to a stubby round nub instead of
// flattening it into a fan.
const BIRD_TAIL_GEOMETRY = new THREE.BufferGeometry();
BIRD_TAIL_GEOMETRY.setAttribute("position", new THREE.Float32BufferAttribute([
  0, 0, 0, -0.075, 0, 0.16, 0.075, 0, 0.16,
], 3));
BIRD_TAIL_GEOMETRY.setIndex([0, 1, 2]);
BIRD_TAIL_GEOMETRY.computeVertexNormals();

// Quadruped leg order shared by deer/fox: [front-left, front-right, back-left, back-right].
const QUAD_LEG_OFFSETS: Array<[number, number]> = [
  [-0.13, -0.28],
  [0.13, -0.28],
  [-0.13, 0.28],
  [0.13, 0.28],
];
interface ArticulatedLeg {
  hip: THREE.Group;
  knee: THREE.Group;
}

function buildQuadLegs(
  upperGeometry: THREE.BufferGeometry,
  lowerGeometry: THREE.BufferGeometry,
  material: THREE.Material,
  hipHeight: number,
  upperLength: number,
  lowerLength: number,
): ArticulatedLeg[] {
  return QUAD_LEG_OFFSETS.map(([x, z]) => {
    const hip = new THREE.Group();
    hip.position.set(x, hipHeight, z);
    const upper = new THREE.Mesh(upperGeometry, material);
    upper.position.y = -upperLength / 2;
    const knee = new THREE.Group();
    knee.position.y = -upperLength;
    const lower = new THREE.Mesh(lowerGeometry, material);
    lower.position.y = -lowerLength / 2;
    knee.add(lower);
    hip.add(upper, knee);
    return { hip, knee };
  });
}

interface GroundBuild {
  root: THREE.Group;
  legs: ArticulatedLeg[];
  isHopper: boolean;
  body: THREE.Object3D;
  head: THREE.Object3D;
  tail: THREE.Object3D;
}

function buildDeer(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.85 + random() * 0.3);
  const torso = new THREE.Mesh(DEER_TORSO_GEOMETRY, DEER_MATERIAL);
  torso.scale.set(0.2, 0.25, 0.43);
  torso.position.set(0, 0.64, 0.02);
  const neck = new THREE.Mesh(DEER_NECK_GEOMETRY, DEER_MATERIAL);
  neck.position.set(0, 0.83, -0.32);
  neck.rotation.x = -0.42;
  const head = new THREE.Mesh(DEER_HEAD_GEOMETRY, DEER_MATERIAL);
  head.scale.set(0.13, 0.15, 0.2);
  head.position.set(0, 1.02, -0.48);
  const muzzle = new THREE.Mesh(DEER_MUZZLE_GEOMETRY, DEER_LIGHT_MATERIAL);
  muzzle.scale.set(0.09, 0.075, 0.14);
  muzzle.position.set(0, -0.025, -0.16);
  head.add(muzzle);
  const tail = new THREE.Group();
  const tailMesh = new THREE.Mesh(DEER_TAIL_GEOMETRY, DEER_LIGHT_MATERIAL);
  tailMesh.rotation.x = 0.4;
  tail.add(tailMesh);
  tail.position.set(0, 0.7, 0.43);
  tail.rotation.x = 0.4;
  root.add(torso, neck, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(DEER_EAR_GEOMETRY, DEER_MATERIAL);
    ear.position.set(side * 0.08, 0.16, -0.01);
    ear.rotation.z = side * 0.5;
    head.add(ear);
  }
  const legs = buildQuadLegs(DEER_UPPER_LEG_GEOMETRY, DEER_LOWER_LEG_GEOMETRY, DEER_MATERIAL, 0.62, 0.3, 0.27);
  legs.forEach((leg) => root.add(leg.hip));
  return { root, legs, isHopper: false, body: torso, head, tail };
}

function buildFox(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.8 + random() * 0.3);
  const torso = new THREE.Mesh(FOX_TORSO_GEOMETRY, FOX_MATERIAL);
  torso.scale.set(0.14, 0.14, 0.34);
  torso.position.set(0, 0.34, 0.01);
  const head = new THREE.Mesh(FOX_HEAD_GEOMETRY, FOX_MATERIAL);
  head.scale.set(0.115, 0.12, 0.15);
  head.position.set(0, 0.45, -0.32);
  const muzzle = new THREE.Mesh(FOX_MUZZLE_GEOMETRY, FOX_DARK_MATERIAL);
  muzzle.position.set(0, -0.025, -0.16);
  muzzle.rotation.x = -Math.PI / 2;
  head.add(muzzle);
  const tail = new THREE.Group();
  const tailMesh = new THREE.Mesh(FOX_TAIL_GEOMETRY, FOX_MATERIAL);
  tailMesh.scale.set(0.075, 0.075, 0.3);
  tailMesh.position.z = 0.22;
  const tailTip = new THREE.Mesh(FOX_TAIL_GEOMETRY, FOX_LIGHT_MATERIAL);
  tailTip.scale.set(0.055, 0.055, 0.1);
  tailTip.position.z = 0.48;
  tail.add(tailMesh, tailTip);
  tail.position.set(0, 0.39, 0.24);
  tail.rotation.x = -0.18;
  root.add(torso, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(FOX_EAR_GEOMETRY, FOX_MATERIAL);
    ear.position.set(side * 0.06, 0.11, -0.02);
    ear.rotation.z = side * 0.3;
    head.add(ear);
  }
  const legs = buildQuadLegs(FOX_UPPER_LEG_GEOMETRY, FOX_LOWER_LEG_GEOMETRY, FOX_DARK_MATERIAL, 0.31, 0.16, 0.15);
  legs.forEach((leg) => root.add(leg.hip));
  return { root, legs, isHopper: false, body: torso, head, tail };
}

function buildRabbit(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.8 + random() * 0.35);
  const body = new THREE.Mesh(RABBIT_BODY_GEOMETRY, RABBIT_MATERIAL);
  body.scale.set(0.95, 1.05, 1.25);
  body.position.y = 0.17;
  const haunch = new THREE.Mesh(RABBIT_HAUNCH_GEOMETRY, RABBIT_MATERIAL);
  haunch.scale.set(0.16, 0.14, 0.19);
  haunch.position.set(0, 0.16, 0.1);
  const head = new THREE.Mesh(RABBIT_HEAD_GEOMETRY, RABBIT_MATERIAL);
  head.position.set(0, 0.26, -0.15);
  const tail = new THREE.Mesh(RABBIT_TAIL_GEOMETRY, RABBIT_MATERIAL);
  tail.position.set(0, 0.18, 0.18);
  root.add(body, haunch, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(RABBIT_EAR_GEOMETRY, RABBIT_MATERIAL);
    ear.position.set(side * 0.05, 0.42, -0.13);
    ear.rotation.x = -0.15;
    root.add(ear);
  }
  return { root, legs: [], isHopper: true, body, head, tail };
}

function buildSquirrel(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.65 + random() * 0.3);
  const body = new THREE.Mesh(SQUIRREL_BODY_GEOMETRY, SQUIRREL_MATERIAL);
  body.scale.set(0.85, 0.85, 1.15);
  body.position.y = 0.12;
  const head = new THREE.Mesh(SQUIRREL_HEAD_GEOMETRY, SQUIRREL_LIGHT_MATERIAL);
  head.position.set(0, 0.2, -0.11);
  const tail = new THREE.Mesh(SQUIRREL_TAIL_GEOMETRY, SQUIRREL_MATERIAL);
  tail.scale.set(0.9, 1.5, 0.65);
  tail.position.set(0, 0.32, 0.14);
  tail.rotation.x = -0.55;
  root.add(body, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(SQUIRREL_EAR_GEOMETRY, SQUIRREL_MATERIAL);
    ear.position.set(side * 0.035, 0.27, -0.11);
    head.add(ear);
  }
  return { root, legs: [], isHopper: true, body, head, tail };
}

function buildSheep(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.85 + random() * 0.3);
  const torso = new THREE.Mesh(SHEEP_BODY_GEOMETRY, SHEEP_WOOL_MATERIAL);
  torso.scale.set(0.24, 0.24, 0.36);
  torso.position.set(0, 0.42, 0);
  const head = new THREE.Mesh(SHEEP_HEAD_GEOMETRY, SHEEP_DARK_MATERIAL);
  head.scale.set(0.12, 0.12, 0.15);
  head.position.set(0, 0.44, -0.34);
  const tail = new THREE.Group();
  const tailMesh = new THREE.Mesh(SHEEP_HEAD_GEOMETRY, SHEEP_WOOL_MATERIAL);
  tailMesh.scale.set(0.07, 0.07, 0.09);
  tail.add(tailMesh);
  tail.position.set(0, 0.44, 0.34);
  root.add(torso, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(SHEEP_EAR_GEOMETRY, SHEEP_DARK_MATERIAL);
    ear.position.set(side * 0.09, 0.02, -0.02);
    ear.rotation.z = side * 0.9;
    head.add(ear);
  }
  const legs = buildQuadLegs(SHEEP_UPPER_LEG_GEOMETRY, SHEEP_LOWER_LEG_GEOMETRY, SHEEP_DARK_MATERIAL, 0.24, 0.22, 0.16);
  legs.forEach((leg) => root.add(leg.hip));
  return { root, legs, isHopper: false, body: torso, head, tail };
}

function buildGroundAnimal(species: GroundSpeciesId, random: () => number): GroundBuild {
  if (species === "deer") return buildDeer(random);
  if (species === "fox") return buildFox(random);
  if (species === "squirrel") return buildSquirrel(random);
  if (species === "sheep") return buildSheep(random);
  return buildRabbit(random);
}

interface BirdBuild {
  root: THREE.Group;
  wingL: THREE.Object3D;
  wingR: THREE.Object3D;
  flapPhase: number;
  flapSpeed: number;
}

function buildBird(random: () => number): BirdBuild {
  const root = new THREE.Group();
  // Sized up from an early pass that read as near-invisible specks against
  // the sky — still a small silhouette, just one a rider can actually spot.
  root.scale.setScalar(1.1 + random() * 0.7);
  const body = new THREE.Mesh(BIRD_BODY_GEOMETRY, BIRD_MATERIAL);
  body.scale.set(0.042, 0.05, 0.2);
  root.add(body);

  // A beak and a fanned tail turn the body from an anonymous blob into
  // something with a clear front and back — cheap in triangles, but it's
  // what makes the silhouette parse as "bird" rather than "flying rock".
  const beak = new THREE.Mesh(BIRD_BEAK_GEOMETRY, BIRD_MATERIAL);
  beak.rotation.x = -Math.PI / 2;
  beak.position.z = -0.085;
  root.add(beak);

  // Already authored flat and tail-pointing in its own geometry — no
  // rotation needed, unlike the wings, which pivot to flap.
  const tail = new THREE.Mesh(BIRD_TAIL_GEOMETRY, BIRD_MATERIAL);
  tail.position.z = 0.09;
  root.add(tail);

  const wingL = new THREE.Group();
  wingL.position.set(-0.02, 0.02, 0);
  const wingLMesh = new THREE.Mesh(BIRD_WING_GEOMETRY, BIRD_MATERIAL);
  wingL.add(wingLMesh);

  const wingR = new THREE.Group();
  wingR.position.set(0.02, 0.02, 0);
  const wingRMesh = new THREE.Mesh(BIRD_WING_GEOMETRY, BIRD_MATERIAL);
  wingRMesh.scale.x = -1;
  wingR.add(wingRMesh);

  root.add(wingL, wingR);
  return { root, wingL, wingR, flapPhase: random() * Math.PI * 2, flapSpeed: 7 + random() * 4 };
}

// ---------------------------------------------------------------------------
// Live encounter state
// ---------------------------------------------------------------------------

interface GroundAnimalInstance {
  root: THREE.Group;
  legs: ArticulatedLeg[];
  isHopper: boolean;
  body: THREE.Object3D;
  head: THREE.Object3D;
  tail: THREE.Object3D;
  bodyRestY: number;
  bodyRestPitch: number;
  headRestPitch: number;
  tailRestYaw: number;
  previous: THREE.Vector3;
  yaw: number;
  gaitPhase: number;
  gaitSpeed: number;
  alongJitter: number;
  lateralWobble: number;
  phaseOffset: number;
  startDelay: number;
}

interface BirdInstance {
  root: THREE.Group;
  wingL: THREE.Object3D;
  wingR: THREE.Object3D;
  offset: THREE.Vector3;
  previous: THREE.Vector3;
  yaw: number;
  flapPhase: number;
  flapSpeed: number;
  glidePhase: number;
  phaseOffset: number;
}

interface GroundEncounter {
  kind: GroundSpeciesId;
  group: THREE.Group;
  animals: GroundAnimalInstance[];
  spawnDistance: number;
  currentDistance: number;
  alongDrift: number;
  lateralStart: number;
  lateralEnd: number;
  age: number;
  lifespan: number;
}

interface FlockEncounter {
  kind: "bird";
  group: THREE.Group;
  birds: BirdInstance[];
  spawnDistance: number;
  currentDistance: number;
  alongDrift: number;
  lateralStart: number;
  lateralEnd: number;
  altitude: number;
  age: number;
  lifespan: number;
}

type Encounter = GroundEncounter | FlockEncounter;

export class WildlifeDirector {
  readonly group = new THREE.Group();
  private readonly world: EndlessWorld;
  private readonly random: () => number;
  private quality: Quality = "high";
  private encounters: Encounter[] = [];
  private spawnTimer: number;
  private readonly scratch = new THREE.Vector3();

  // Ambient flocks live in their own group, kept separate from `group` (the
  // rare "encounter" system) so the two never compete for the same caps and
  // existing encounter bookkeeping doesn't have to account for them.
  readonly ambientGroup = new THREE.Group();
  private ambientFlocks: FlockEncounter[] = [];
  private ambientRespawnTimer = 0;

  constructor(world: EndlessWorld, random: () => number = Math.random) {
    this.group.name = "wildlife";
    this.ambientGroup.name = "wildlife-ambient";
    this.world = world;
    this.random = random;
    this.spawnTimer = firstSpawnDelay(this.random);
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
  }

  reset(): void {
    for (const encounter of this.encounters) this.group.remove(encounter.group);
    this.encounters = [];
    for (const flock of this.ambientFlocks) this.ambientGroup.remove(flock.group);
    this.ambientFlocks = [];
    this.ambientRespawnTimer = 0;
    this.spawnTimer = firstSpawnDelay(this.random);
  }

  update(dt: number, riderDistance: number, nightAmount: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const spawned = this.trySpawn(riderDistance, clamp01(nightAmount));
      this.spawnTimer = spawned ? nextSpawnDelay(this.random) : RETRY_DELAY_SECONDS;
    }
    this.stepEncounters(dt, riderDistance);
    this.stepAmbientFlocks(dt, riderDistance, clamp01(nightAmount));
  }

  private stepAmbientFlocks(dt: number, riderDistance: number, nightAmount: number): void {
    for (let i = this.ambientFlocks.length - 1; i >= 0; i -= 1) {
      const flock = this.ambientFlocks[i];
      flock.age += dt;
      this.stepFlock(flock, dt);
      const behind = riderDistance - flock.currentDistance;
      if (flock.age >= flock.lifespan || behind > BEHIND_DESPAWN_DISTANCE) {
        this.ambientGroup.remove(flock.group);
        this.ambientFlocks.splice(i, 1);
        this.ambientRespawnTimer = randomInRange(this.random, AMBIENT_RESPAWN_GAP.min, AMBIENT_RESPAWN_GAP.max);
      }
    }

    this.ambientRespawnTimer -= dt;
    const target = AMBIENT_FLOCK_TARGET[this.quality];
    const wanted = nightAmount > AMBIENT_NIGHT_CUTOFF ? Math.max(0, target - 1) : target;
    if (this.ambientFlocks.length < wanted && this.ambientRespawnTimer <= 0) {
      const distance = riderDistance + randomInRange(this.random, 18, 45);
      const flock = this.createFlock(distance, ambientFlockSize(this.random, this.quality), true);
      this.ambientFlocks.push(flock);
      this.ambientGroup.add(flock.group);
    }
  }

  private totalAnimals(): number {
    let total = 0;
    for (const encounter of this.encounters) {
      total += encounter.kind === "bird" ? encounter.birds.length : encounter.animals.length;
    }
    return total;
  }

  private trySpawn(riderDistance: number, nightAmount: number): boolean {
    if (this.encounters.length >= ENCOUNTER_CAPS[this.quality]) return false;

    const species = pickSpecies(this.random, nightAmount);
    const prospectiveCount = species === "bird" ? flockSize(this.random, this.quality) : groupSize(species, this.random);
    if (this.totalAnimals() + prospectiveCount > ANIMAL_CAPS[this.quality]) return false;

    const minGap = species === "bird" ? FLOCK_MIN_GAP : GROUND_MIN_GAP;
    const others = this.encounters.map((encounter) => encounter.currentDistance);
    let candidateDistance = riderDistance + spawnAheadOffset(this.random);
    let attempts = 0;
    while (!isFarEnough(candidateDistance, others, minGap) && attempts < 3) {
      candidateDistance = riderDistance + spawnAheadOffset(this.random);
      attempts += 1;
    }
    if (!isFarEnough(candidateDistance, others, minGap)) return false;

    const encounter =
      species === "bird"
        ? this.createFlock(candidateDistance, prospectiveCount)
        : this.createGroundEncounter(species, candidateDistance, prospectiveCount);
    this.encounters.push(encounter);
    this.group.add(encounter.group);
    return true;
  }

  private createFlock(distance: number, count: number, ambient = false): FlockEncounter {
    const params = ambient ? ambientFlockMotionParams(this.random) : flockMotionParams(this.random);
    const group = new THREE.Group();
    group.name = "wildlife-flock";
    const birds: BirdInstance[] = [];
    for (let i = 0; i < count; i += 1) {
      const built = buildBird(this.random);
      const offset = new THREE.Vector3(
        (this.random() - 0.5) * 6,
        (this.random() - 0.5) * 3,
        (this.random() - 0.5) * 8,
      );
      built.root.position.copy(offset);
      group.add(built.root);

      // Seed `previous` at the bird's actual spawn point so the first frame's
      // facing-direction delta isn't computed against the world origin.
      this.world.groundPosition(distance, params.lateralStart, this.scratch);
      const previous = new THREE.Vector3(
        this.scratch.x + offset.x,
        this.scratch.y + params.altitude + offset.y,
        this.scratch.z + offset.z,
      );
      built.root.position.copy(previous);

      birds.push({
        root: built.root,
        wingL: built.wingL,
        wingR: built.wingR,
        offset,
        previous,
        yaw: 0,
        flapPhase: built.flapPhase,
        flapSpeed: built.flapSpeed,
        glidePhase: this.random() * Math.PI * 2,
        phaseOffset: this.random() * Math.PI * 2,
      });
    }
    return {
      kind: "bird",
      group,
      birds,
      spawnDistance: distance,
      currentDistance: distance,
      alongDrift: params.alongDrift,
      lateralStart: params.lateralStart,
      lateralEnd: params.lateralEnd,
      altitude: params.altitude,
      age: 0,
      lifespan: params.lifespan,
    };
  }

  private createGroundEncounter(species: GroundSpeciesId, distance: number, count: number): GroundEncounter {
    const params = groundMotionParams(species, this.world.roadHalfWidth(), this.random);
    const group = new THREE.Group();
    group.name = `wildlife-${species}`;
    const animals: GroundAnimalInstance[] = [];
    for (let i = 0; i < count; i += 1) {
      const built = buildGroundAnimal(species, this.random);
      const alongJitter = (i - (count - 1) / 2) * 0.9 + (this.random() - 0.5) * 0.4;
      group.add(built.root);

      this.world.groundPosition(distance + alongJitter, params.lateralStart, this.scratch);
      const previous = this.scratch.clone();
      built.root.position.copy(previous);

      animals.push({
        root: built.root,
        legs: built.legs,
        isHopper: built.isHopper,
        body: built.body,
        head: built.head,
        tail: built.tail,
        bodyRestY: built.body.position.y,
        bodyRestPitch: built.body.rotation.x,
        headRestPitch: built.head.rotation.x,
        tailRestYaw: built.tail.rotation.y,
        previous,
        yaw: 0,
        gaitPhase: this.random() * Math.PI * 2,
        gaitSpeed:
          species === "fox" || species === "squirrel"
            ? 9 + this.random() * 3
            : species === "sheep"
              ? 3.5 + this.random() * 1.5
              : 6 + this.random() * 2,
        alongJitter,
        lateralWobble: species === "sheep" ? 0.15 + this.random() * 0.2 : 0.3 + this.random() * 0.4,
        phaseOffset: this.random() * Math.PI * 2,
        // Staggered so a group doesn't notice the rider and bolt in
        // perfect lockstep — each animal gets its own beat before it moves.
        startDelay: count > 1 ? this.random() * 0.7 : 0,
      });
    }
    return {
      kind: species,
      group,
      animals,
      spawnDistance: distance,
      currentDistance: distance,
      alongDrift: params.alongDrift,
      lateralStart: params.lateralStart,
      lateralEnd: params.lateralEnd,
      age: 0,
      lifespan: params.lifespan,
    };
  }

  private stepEncounters(dt: number, riderDistance: number): void {
    for (let i = this.encounters.length - 1; i >= 0; i -= 1) {
      const encounter = this.encounters[i];
      encounter.age += dt;
      if (encounter.kind === "bird") this.stepFlock(encounter, dt);
      else this.stepGround(encounter, dt);

      const behind = riderDistance - encounter.currentDistance;
      if (encounter.age >= encounter.lifespan || behind > BEHIND_DESPAWN_DISTANCE) {
        this.group.remove(encounter.group);
        this.encounters.splice(i, 1);
      }
    }
  }

  private stepFlock(encounter: FlockEncounter, dt: number): void {
    const f = smoothEase(encounter.age / encounter.lifespan);
    encounter.currentDistance = encounter.spawnDistance + encounter.alongDrift * f;
    const laneLateral = lerpNum(encounter.lateralStart, encounter.lateralEnd, f);
    this.world.groundPosition(encounter.currentDistance, laneLateral, this.scratch);
    const baseX = this.scratch.x;
    const baseY = this.scratch.y + encounter.altitude;
    const baseZ = this.scratch.z;

    for (const bird of encounter.birds) {
      bird.flapPhase += dt * bird.flapSpeed;
      bird.glidePhase += dt * 0.52;
      const pose = birdFlightPose(bird.flapPhase, bird.glidePhase + bird.phaseOffset * 0.25);
      const wobble = Math.sin(encounter.age * 0.6 + bird.phaseOffset) * 1.2;
      const x = baseX + bird.offset.x;
      const y = baseY + bird.offset.y + pose.lift;
      const z = baseZ + bird.offset.z + wobble;

      const dx = x - bird.previous.x;
      const dz = z - bird.previous.z;
      bird.yaw = dampAngle(bird.yaw, computeFacingYaw(dx, dz, bird.yaw), 7, dt);
      bird.previous.set(x, y, z);

      bird.root.position.set(x, y, z);
      bird.root.rotation.y = bird.yaw;
      bird.root.rotation.x = pose.bodyPitch;
      bird.root.rotation.z = Math.sin(encounter.age * 0.38 + bird.phaseOffset) * 0.08;
      bird.wingL.rotation.z = pose.wing;
      bird.wingR.rotation.z = -pose.wing;
    }
  }

  private stepGround(encounter: GroundEncounter, dt: number): void {
    // `currentDistance` (used for despawn/spacing bookkeeping) tracks the
    // encounter's own unstaggered progress; each animal below eases along
    // its own slightly delayed timeline instead, so a group doesn't move as
    // one rigid block.
    const f = smoothEase(encounter.age / encounter.lifespan);
    encounter.currentDistance = encounter.spawnDistance + encounter.alongDrift * f;

    for (const animal of encounter.animals) {
      const animalF = groundProgress((encounter.age - animal.startDelay) / encounter.lifespan);
      const along = encounter.spawnDistance + encounter.alongDrift * animalF + animal.alongJitter;
      const laneLateral = lerpNum(encounter.lateralStart, encounter.lateralEnd, animalF);
      const lateral = laneLateral + Math.sin(encounter.age * 1.4 + animal.phaseOffset) * animal.lateralWobble;
      this.world.groundPosition(along, lateral, this.scratch);

      const dx = this.scratch.x - animal.previous.x;
      const dz = this.scratch.z - animal.previous.z;
      const travel = Math.hypot(dx, dz);
      animal.gaitPhase += travel * animal.gaitSpeed;
      animal.yaw = dampAngle(animal.yaw, computeFacingYaw(dx, dz, animal.yaw), 9, dt);
      animal.previous.copy(this.scratch);

      if (animal.isHopper) {
        // Both rabbit and squirrel hop; only their build (ears, tail, scale)
        // differs, so they share this animation curve.
        const pose = rabbitPose(animal.gaitPhase);
        animal.root.position.set(this.scratch.x, this.scratch.y + pose.lift, this.scratch.z);
        animal.body.rotation.x = animal.bodyRestPitch + pose.bodyPitch;
        animal.head.rotation.x = animal.headRestPitch + pose.headPitch;
      } else {
        const pose = quadrupedPose(encounter.kind as "deer" | "fox" | "sheep", animal.gaitPhase);
        animal.root.position.set(this.scratch.x, this.scratch.y, this.scratch.z);
        animal.body.position.y = animal.bodyRestY + pose.bodyBob;
        animal.body.rotation.x = animal.bodyRestPitch + pose.bodyPitch;
        animal.head.rotation.x = animal.headRestPitch + pose.headPitch;
        animal.tail.rotation.y = animal.tailRestYaw + pose.tailYaw;
        for (let i = 0; i < animal.legs.length; i += 1) {
          animal.legs[i].hip.rotation.x = pose.legSwing[i];
          animal.legs[i].knee.rotation.x = pose.kneeBend[i];
        }
      }
      animal.root.rotation.y = animal.yaw;
    }
  }
}
