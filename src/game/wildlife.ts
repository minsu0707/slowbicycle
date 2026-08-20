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

export type SpeciesId = "bird" | "deer" | "fox" | "rabbit";
type GroundSpeciesId = "deer" | "fox" | "rabbit";
type Quality = "low" | "high";

export const SPAWN_INTERVAL_RANGE = { min: 10, max: 26 } as const;
export const FIRST_SPAWN_RANGE = { min: 5, max: 10 } as const;
export const SPAWN_AHEAD_RANGE = { min: 35, max: 75 } as const;
export const RETRY_DELAY_SECONDS = 4;
export const BEHIND_DESPAWN_DISTANCE = 20;
export const GROUND_MIN_GAP = 14;
export const FLOCK_MIN_GAP = 25;
export const ENCOUNTER_CAPS: Record<Quality, number> = { low: 2, high: 3 };
export const ANIMAL_CAPS: Record<Quality, number> = { low: 7, high: 14 };

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
  return species === "bird" ? randomInRange(random, 10, 16) : randomInRange(random, 8, 14);
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

export function groupSize(species: GroundSpeciesId, random: () => number): number {
  if (species === "deer") return random() < 0.35 ? 2 : 1;
  if (species === "rabbit") return 1 + Math.floor(random() * 3);
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

// ---------------------------------------------------------------------------
// Shared geometry/materials — module singletons, reused across every spawn.
// ---------------------------------------------------------------------------

const DEER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 1, flatShading: true });
const DEER_TORSO_GEOMETRY = new THREE.BoxGeometry(0.34, 0.36, 0.72);
const DEER_HEAD_GEOMETRY = new THREE.BoxGeometry(0.2, 0.22, 0.3);
const DEER_EAR_GEOMETRY = new THREE.ConeGeometry(0.05, 0.16, 4);
const DEER_TAIL_GEOMETRY = new THREE.ConeGeometry(0.05, 0.14, 5);
const DEER_LEG_GEOMETRY = new THREE.CylinderGeometry(0.035, 0.045, 0.5, 5);

const FOX_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb5592f, roughness: 1, flatShading: true });
const FOX_TORSO_GEOMETRY = new THREE.BoxGeometry(0.2, 0.22, 0.48);
const FOX_HEAD_GEOMETRY = new THREE.BoxGeometry(0.14, 0.14, 0.18);
const FOX_EAR_GEOMETRY = new THREE.ConeGeometry(0.045, 0.13, 4);
const FOX_TAIL_GEOMETRY = new THREE.ConeGeometry(0.07, 0.42, 6);
const FOX_LEG_GEOMETRY = new THREE.CylinderGeometry(0.022, 0.028, 0.26, 5);

const RABBIT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 1, flatShading: true });
const RABBIT_BODY_GEOMETRY = new THREE.IcosahedronGeometry(0.17, 0);
const RABBIT_HEAD_GEOMETRY = new THREE.IcosahedronGeometry(0.1, 0);
const RABBIT_EAR_GEOMETRY = new THREE.ConeGeometry(0.03, 0.22, 4);
const RABBIT_TAIL_GEOMETRY = new THREE.IcosahedronGeometry(0.055, 0);

// Birds read as small dark silhouettes against the sky — unlit is both cheaper
// and truer to how a distant flock actually looks.
const BIRD_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x2c2a26, fog: true });
const BIRD_BODY_GEOMETRY = new THREE.ConeGeometry(0.045, 0.3, 4);
const BIRD_WING_GEOMETRY = new THREE.BoxGeometry(0.4, 0.012, 0.12);

// Quadruped leg order shared by deer/fox: [front-left, front-right, back-left, back-right].
const QUAD_LEG_OFFSETS: Array<[number, number]> = [
  [-0.13, -0.28],
  [0.13, -0.28],
  [-0.13, 0.28],
  [0.13, 0.28],
];
// Diagonal trot: FL+BR share a phase, FR+BL share the other.
const QUAD_LEG_PHASES = [0, Math.PI, Math.PI, 0];

function buildQuadLegs(geometry: THREE.BufferGeometry, material: THREE.Material, hipHeight: number, legLength: number): THREE.Group[] {
  return QUAD_LEG_OFFSETS.map(([x, z]) => {
    const hip = new THREE.Group();
    hip.position.set(x, hipHeight, z);
    const leg = new THREE.Mesh(geometry, material);
    leg.position.y = -legLength / 2;
    hip.add(leg);
    return hip;
  });
}

interface GroundBuild {
  root: THREE.Group;
  legs: THREE.Group[];
  isHopper: boolean;
}

function buildDeer(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.85 + random() * 0.3);
  const torso = new THREE.Mesh(DEER_TORSO_GEOMETRY, DEER_MATERIAL);
  torso.position.set(0, 0.62, 0);
  const head = new THREE.Mesh(DEER_HEAD_GEOMETRY, DEER_MATERIAL);
  head.position.set(0, 0.86, -0.5);
  const tail = new THREE.Mesh(DEER_TAIL_GEOMETRY, DEER_MATERIAL);
  tail.position.set(0, 0.7, 0.38);
  tail.rotation.x = 0.4;
  root.add(torso, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(DEER_EAR_GEOMETRY, DEER_MATERIAL);
    ear.position.set(side * 0.08, 0.98, -0.56);
    ear.rotation.z = side * 0.5;
    root.add(ear);
  }
  const legs = buildQuadLegs(DEER_LEG_GEOMETRY, DEER_MATERIAL, 0.62, 0.5);
  legs.forEach((leg) => root.add(leg));
  return { root, legs, isHopper: false };
}

function buildFox(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.8 + random() * 0.3);
  const torso = new THREE.Mesh(FOX_TORSO_GEOMETRY, FOX_MATERIAL);
  torso.position.set(0, 0.32, 0);
  const head = new THREE.Mesh(FOX_HEAD_GEOMETRY, FOX_MATERIAL);
  head.position.set(0, 0.4, -0.3);
  const tail = new THREE.Mesh(FOX_TAIL_GEOMETRY, FOX_MATERIAL);
  tail.position.set(0, 0.4, 0.36);
  tail.rotation.x = -0.55;
  root.add(torso, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(FOX_EAR_GEOMETRY, FOX_MATERIAL);
    ear.position.set(side * 0.06, 0.5, -0.34);
    ear.rotation.z = side * 0.3;
    root.add(ear);
  }
  const legs = buildQuadLegs(FOX_LEG_GEOMETRY, FOX_MATERIAL, 0.32, 0.26);
  legs.forEach((leg) => root.add(leg));
  return { root, legs, isHopper: false };
}

function buildRabbit(random: () => number): GroundBuild {
  const root = new THREE.Group();
  root.scale.setScalar(0.8 + random() * 0.35);
  const body = new THREE.Mesh(RABBIT_BODY_GEOMETRY, RABBIT_MATERIAL);
  body.position.y = 0.17;
  const head = new THREE.Mesh(RABBIT_HEAD_GEOMETRY, RABBIT_MATERIAL);
  head.position.set(0, 0.26, -0.15);
  const tail = new THREE.Mesh(RABBIT_TAIL_GEOMETRY, RABBIT_MATERIAL);
  tail.position.set(0, 0.18, 0.18);
  root.add(body, head, tail);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(RABBIT_EAR_GEOMETRY, RABBIT_MATERIAL);
    ear.position.set(side * 0.05, 0.42, -0.13);
    ear.rotation.x = -0.15;
    root.add(ear);
  }
  return { root, legs: [], isHopper: true };
}

function buildGroundAnimal(species: GroundSpeciesId, random: () => number): GroundBuild {
  if (species === "deer") return buildDeer(random);
  if (species === "fox") return buildFox(random);
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
  root.scale.setScalar(0.7 + random() * 0.6);
  const body = new THREE.Mesh(BIRD_BODY_GEOMETRY, BIRD_MATERIAL);
  // Cone apex points +Y by default; rotate so it points along -Z, matching
  // the world's forward convention (see the module doc comment above).
  body.rotation.x = -Math.PI / 2;
  root.add(body);

  const wingL = new THREE.Group();
  wingL.position.set(-0.02, 0.02, 0);
  const wingLMesh = new THREE.Mesh(BIRD_WING_GEOMETRY, BIRD_MATERIAL);
  wingLMesh.position.x = -0.2;
  wingL.add(wingLMesh);

  const wingR = new THREE.Group();
  wingR.position.set(0.02, 0.02, 0);
  const wingRMesh = new THREE.Mesh(BIRD_WING_GEOMETRY, BIRD_MATERIAL);
  wingRMesh.position.x = 0.2;
  wingR.add(wingRMesh);

  root.add(wingL, wingR);
  return { root, wingL, wingR, flapPhase: random() * Math.PI * 2, flapSpeed: 7 + random() * 4 };
}

// ---------------------------------------------------------------------------
// Live encounter state
// ---------------------------------------------------------------------------

interface GroundAnimalInstance {
  root: THREE.Group;
  legs: THREE.Group[];
  isHopper: boolean;
  previous: THREE.Vector3;
  yaw: number;
  gaitPhase: number;
  gaitSpeed: number;
  alongJitter: number;
  lateralWobble: number;
  phaseOffset: number;
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

  constructor(world: EndlessWorld, random: () => number = Math.random) {
    this.group.name = "wildlife";
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
    this.spawnTimer = firstSpawnDelay(this.random);
  }

  update(dt: number, riderDistance: number, nightAmount: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const spawned = this.trySpawn(riderDistance, clamp01(nightAmount));
      this.spawnTimer = spawned ? nextSpawnDelay(this.random) : RETRY_DELAY_SECONDS;
    }
    this.stepEncounters(dt, riderDistance);
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

  private createFlock(distance: number, count: number): FlockEncounter {
    const params = flockMotionParams(this.random);
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
        previous,
        yaw: 0,
        gaitPhase: this.random() * Math.PI * 2,
        gaitSpeed: species === "fox" ? 9 + this.random() * 3 : 6 + this.random() * 2,
        alongJitter,
        lateralWobble: 0.3 + this.random() * 0.4,
        phaseOffset: this.random() * Math.PI * 2,
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
      const wobble = Math.sin(encounter.age * 0.6 + bird.phaseOffset) * 1.2;
      const x = baseX + bird.offset.x;
      const y = baseY + bird.offset.y + Math.sin(bird.flapPhase * 0.5) * 0.15;
      const z = baseZ + bird.offset.z + wobble;

      const dx = x - bird.previous.x;
      const dz = z - bird.previous.z;
      bird.yaw = computeFacingYaw(dx, dz, bird.yaw);
      bird.previous.set(x, y, z);

      bird.root.position.set(x, y, z);
      bird.root.rotation.y = bird.yaw;
      bird.wingL.rotation.z = Math.sin(bird.flapPhase) * 0.7 + 0.15;
      bird.wingR.rotation.z = -Math.sin(bird.flapPhase) * 0.7 - 0.15;
    }
  }

  private stepGround(encounter: GroundEncounter, dt: number): void {
    const f = smoothEase(encounter.age / encounter.lifespan);
    encounter.currentDistance = encounter.spawnDistance + encounter.alongDrift * f;
    const laneLateral = lerpNum(encounter.lateralStart, encounter.lateralEnd, f);

    for (const animal of encounter.animals) {
      animal.gaitPhase += dt * animal.gaitSpeed;
      const along = encounter.currentDistance + animal.alongJitter;
      const lateral = laneLateral + Math.sin(encounter.age * 1.4 + animal.phaseOffset) * animal.lateralWobble;
      this.world.groundPosition(along, lateral, this.scratch);

      const dx = this.scratch.x - animal.previous.x;
      const dz = this.scratch.z - animal.previous.z;
      animal.yaw = computeFacingYaw(dx, dz, animal.yaw);
      animal.previous.copy(this.scratch);

      if (animal.isHopper) {
        const hop = Math.max(0, Math.sin(animal.gaitPhase));
        animal.root.position.set(this.scratch.x, this.scratch.y + hop * 0.14, this.scratch.z);
      } else {
        animal.root.position.copy(this.scratch);
        for (let i = 0; i < animal.legs.length; i += 1) {
          animal.legs[i].rotation.x = Math.sin(animal.gaitPhase + QUAD_LEG_PHASES[i]) * 0.5;
        }
      }
      animal.root.rotation.y = animal.yaw;
    }
  }
}
