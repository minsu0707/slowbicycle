import { mulberry32, roadPoint } from "./procedural";

// ---------------------------------------------------------------------------
// Deterministic landmark planning.
//
// The route is cut into fixed `SLOT_LENGTH` windows and every window owns
// exactly one landmark. Where inside its window a landmark lands is seeded
// jitter, so the ride feels unscheduled, but because the centre always keeps
// `SLOT_MARGIN` clear of both slot edges the spacing is provably bounded:
// consecutive landmarks are never closer than `MIN_LANDMARK_GAP` (nothing ever
// stacks up back to back) and never further apart than `MAX_LANDMARK_GAP` (the
// ride never goes barren). Slot 0 is special-cased to land early so a fresh
// ride meets a landmark within its first minute.
//
// Nothing here touches THREE beyond `roadPoint` — these are pure functions of
// distance, so `world.ts` can carve terrain with them and the tests can check
// spacing/ranges/influence without a renderer. `landmark-scenery.ts` builds
// its meshes from the very same plans, which is what keeps the carved gorge
// and the bridge deck agreeing on where the ground is.
// ---------------------------------------------------------------------------

export type LandmarkKind = "bridge" | "waterfall";

/** Every window of this many metres of road owns exactly one landmark. */
export const SLOT_LENGTH = 900;
/** A landmark centre stays at least this far from its slot's edges. */
export const SLOT_MARGIN = 250;
/** Width of the jitter window a centre may land in. */
export const CENTER_WINDOW = SLOT_LENGTH - 2 * SLOT_MARGIN;
/** Guaranteed minimum distance between two consecutive landmark centres. */
export const MIN_LANDMARK_GAP = SLOT_LENGTH - CENTER_WINDOW;
/** Guaranteed maximum distance between two consecutive landmark centres. */
export const MAX_LANDMARK_GAP = SLOT_LENGTH + CENTER_WINDOW;
/** The very first landmark lands here so a fresh ride meets one early. */
export const FIRST_LANDMARK_RANGE = { min: 210, max: 330 } as const;
/**
 * No landmark may deform the ground within this lateral distance of the road
 * centre — the shoulder ends at 3.5m, so this leaves the ridable surface and
 * its verge untouched. Bridges are the deliberate exception: their gorge runs
 * *under* the road and the deck spans it.
 */
export const LANDMARK_ROAD_CLEARANCE = 7.5;
/** How far below the road surface a bridge deck's top face sits. */
export const DECK_TOP_DROP = 0.09;

interface LandmarkPlanBase {
  /** Index of the slot that owns this landmark. */
  readonly slot: number;
  /** Distance along the road of the landmark's centre. */
  readonly center: number;
  /** Which side of the road the landmark leans to (+1 = road-right). */
  readonly side: 1 | -1;
  /** Stable seed for the scene builder's own jitter (rocks, reeds, jag). */
  readonly seed: number;
}

/** A river gorge crossed by a road bridge. The ridable surface is untouched. */
export interface BridgePlan extends LandmarkPlanBase {
  readonly kind: "bridge";
  /** Half the deck length; also the half-length of the carved gorge. */
  readonly halfSpan: number;
  /** How far below the road the gorge floor sits. */
  readonly gorgeDepth: number;
  /** How high the water stands above the gorge floor. */
  readonly waterRise: number;
  /** Lateral half-extent over which the gorge fades back into the hills. */
  readonly valleyHalfWidth: number;
  /** Lateral half-extent of the water surface (kept inside the valley). */
  readonly riverHalfWidth: number;
  /** Along-road half-extent of the water surface (kept on the flat floor). */
  readonly riverHalfLength: number;
  readonly deckHalfWidth: number;
  readonly deckThickness: number;
  readonly railHeight: number;
  readonly postSpacing: number;
}

/** A roadside cliff with water falling into a plunge pool, clear of the road. */
export interface WaterfallPlan extends LandmarkPlanBase {
  readonly kind: "waterfall";
  /** Lateral distance from the road centre to the cliff face. */
  readonly cliffOffset: number;
  /** Height of the cliff crest above the road. */
  readonly cliffHeight: number;
  /** Along-road half-extent of the cliff. */
  readonly cliffHalfLength: number;
  /** How far the outcrop extends away from the road. */
  readonly cliffDepth: number;
  readonly fallWidth: number;
  /** Layered translucent sheets that make up the falling water. */
  readonly fallSheets: number;
  readonly poolRadius: number;
  readonly poolDepth: number;
  /** Signed lateral position of the plunge pool's centre. */
  readonly poolLateral: number;
}

export type LandmarkPlan = BridgePlan | WaterfallPlan;

/** How the terrain should react to landmarks at a road-relative position. */
export interface TerrainCarve {
  /** Metres to add to the base terrain height. */
  heightDelta: number;
  /** 0..1 — how strongly the ambient terrain wave should be suppressed. */
  flatten: number;
  /** The landmark responsible, or null when nothing reaches this point. */
  plan: LandmarkPlan | null;
}

const NO_CARVE: TerrainCarve = { heightDelta: 0, flatten: 0, plan: null };

function smoothstep(value: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function range(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

export function landmarkSlotIndex(distance: number): number {
  return Math.floor(distance / SLOT_LENGTH);
}

/**
 * Slots are dealt out in pairs, and each pair holds one bridge and one
 * waterfall in a seeded order. Both types therefore keep showing up (every
 * aligned pair covers both) and same-type runs cap at two, while the order
 * inside a pair still reads as random.
 */
export function landmarkKindForSlot(slot: number): LandmarkKind {
  const pair = Math.floor(slot / 2);
  const bridgeFirst = mulberry32(pair * 26_183 + 977)() < 0.5;
  const isSecond = slot - pair * 2 === 1;
  return isSecond === bridgeFirst ? "waterfall" : "bridge";
}

// Plans are pure functions of the slot index, so memoising them is safe. The
// terrain carve is sampled once per terrain vertex, which would otherwise
// re-run the generator thousands of times per chunk.
const planCache = new Map<number, LandmarkPlan | null>();

/** The landmark owned by a slot, or null for slots before the ride starts. */
export function planLandmark(slot: number): LandmarkPlan | null {
  const cached = planCache.get(slot);
  if (cached !== undefined) return cached;
  const plan = buildPlan(slot);
  if (planCache.size > 128) planCache.clear();
  planCache.set(slot, plan);
  return plan;
}

function buildPlan(slot: number): LandmarkPlan | null {
  if (!Number.isFinite(slot) || slot < 0) return null;
  const index = Math.floor(slot);
  const random = mulberry32(index * 88_399 + 1_301);
  const center = index === 0
    ? range(random, FIRST_LANDMARK_RANGE.min, FIRST_LANDMARK_RANGE.max)
    : index * SLOT_LENGTH + SLOT_MARGIN + random() * CENTER_WINDOW;
  const side: 1 | -1 = random() < 0.5 ? -1 : 1;
  const seed = 1 + Math.floor(random() * 1_000_000);

  if (landmarkKindForSlot(index) === "bridge") {
    const halfSpan = range(random, 22, 30);
    const valleyHalfWidth = range(random, 70, 100);
    return {
      kind: "bridge",
      slot: index,
      center,
      side,
      seed,
      halfSpan,
      gorgeDepth: range(random, 7.5, 11),
      waterRise: range(random, 2.4, 3.1),
      valleyHalfWidth,
      riverHalfWidth: valleyHalfWidth * 0.78,
      riverHalfLength: halfSpan * 0.45,
      deckHalfWidth: range(random, 3.7, 4.1),
      deckThickness: range(random, 0.55, 0.85),
      railHeight: range(random, 0.95, 1.15),
      postSpacing: range(random, 2.6, 3.4),
    };
  }

  // The pool sits at the cliff base, so tying the cliff's distance to the pool
  // radius is what guarantees `LANDMARK_ROAD_CLEARANCE` for every draw.
  const poolRadius = range(random, 4.2, 6.5);
  const cliffOffset = 9 + poolRadius + range(random, 0, 4.5);
  return {
    kind: "waterfall",
    slot: index,
    center,
    side,
    seed,
    cliffOffset,
    cliffHeight: range(random, 9, 15),
    cliffHalfLength: range(random, 15, 22),
    cliffDepth: range(random, 18, 26),
    fallWidth: range(random, 3.2, 5.6),
    fallSheets: random() < 0.4 ? 2 : 3,
    poolRadius,
    poolDepth: range(random, 0.9, 1.7),
    poolLateral: side * (cliffOffset - poolRadius * 0.35),
  };
}

/**
 * Landmarks whose centre falls in `[from, to)`. Chunk builders should use this
 * exact half-open rule: a landmark then belongs to exactly one chunk even
 * though its scenery reaches past that chunk's bounds.
 */
export function landmarksInRange(from: number, to: number): LandmarkPlan[] {
  const found: LandmarkPlan[] = [];
  const first = landmarkSlotIndex(from) - 1;
  const last = landmarkSlotIndex(to) + 1;
  for (let slot = first; slot <= last; slot += 1) {
    const plan = planLandmark(slot);
    if (plan && plan.center >= from && plan.center < to) found.push(plan);
  }
  return found;
}

/** Along-road span a landmark reaches, scenery and terrain blend included. */
export function landmarkSpan(plan: LandmarkPlan): { start: number; end: number } {
  const reach = plan.kind === "bridge" ? plan.halfSpan + 6 : plan.cliffHalfLength + 16;
  return { start: plan.center - reach, end: plan.center + reach };
}

/** Absolute height of a bridge's river surface. */
export function bridgeWaterY(plan: BridgePlan): number {
  return roadPoint(plan.center).y - plan.gorgeDepth + plan.waterRise;
}

/** Absolute height of a bridge's gorge floor at its deepest. */
export function bridgeFloorY(plan: BridgePlan): number {
  return roadPoint(plan.center).y - plan.gorgeDepth;
}

/** Absolute height of the deck's upper face — just under the road surface. */
export function bridgeDeckTopY(distance: number): number {
  return roadPoint(distance).y - DECK_TOP_DROP;
}

/** Absolute height of a waterfall's plunge-pool surface. */
export function waterfallPoolY(plan: WaterfallPlan): number {
  return roadPoint(plan.center).y - 0.35 - plan.poolDepth * 0.45;
}

/** Absolute height of a waterfall's crest, where the water leaves the cliff. */
export function waterfallCrestY(plan: WaterfallPlan): number {
  return roadPoint(plan.center).y + plan.cliffHeight;
}

/** Lateral gap between the road centre and the nearest edge of the pool. */
export function waterfallRoadClearance(plan: WaterfallPlan): number {
  return Math.abs(plan.poolLateral) - plan.poolRadius;
}

/**
 * Terrain reaction at a road-relative position: how far the ground moves and
 * how much of the ambient terrain wave to drop. `world.ts` applies both, which
 * is what makes the carved ground match the landmark meshes exactly.
 */
export function landmarkTerrainCarve(distance: number, lateral: number): TerrainCarve {
  if (!Number.isFinite(distance) || !Number.isFinite(lateral)) return NO_CARVE;
  let strongest = NO_CARVE;
  const middle = landmarkSlotIndex(distance);
  for (let slot = middle - 1; slot <= middle + 1; slot += 1) {
    const plan = planLandmark(slot);
    if (!plan) continue;
    const carve = carveFor(plan, distance, lateral);
    // Landmarks are spaced far wider than their reach, so overlap is only a
    // theoretical worry — take the dominant one rather than summing, which
    // would let a bridge gorge and a waterfall hillside cancel each other out.
    if (carve.flatten > strongest.flatten) strongest = carve;
  }
  return strongest;
}

/** Convenience wrapper for callers that only need the height offset. */
export function landmarkTerrainDelta(distance: number, lateral: number): number {
  return landmarkTerrainCarve(distance, lateral).heightDelta;
}

function carveFor(plan: LandmarkPlan, distance: number, lateral: number): TerrainCarve {
  return plan.kind === "bridge"
    ? carveBridge(plan, distance, lateral)
    : carveWaterfall(plan, distance, lateral);
}

/**
 * The gorge is flat-bottomed under the middle of the deck and climbs back to
 * road level exactly at the deck's ends, so the deck always covers the void
 * and the abutments land on solid ground.
 */
function carveBridge(plan: BridgePlan, distance: number, lateral: number): TerrainCarve {
  const along = 1 - smoothstep(Math.abs(distance - plan.center) / plan.halfSpan, 0.35, 1);
  if (along <= 0) return NO_CARVE;
  const across = 1 - smoothstep(Math.abs(lateral) / plan.valleyHalfWidth, 0.8, 1.25);
  const weight = along * across;
  if (weight <= 0) return NO_CARVE;
  // Anchored to the road height at the centre so the floor — and therefore the
  // flat water surface above it — stays level across the whole crossing.
  const target = roadPoint(plan.center).y - plan.gorgeDepth;
  return { heightDelta: (target - roadPoint(distance).y) * weight, flatten: weight, plan };
}

/**
 * The cliff is free-standing geometry, so the terrain only has to agree with it
 * broadly: a gentle hillside rising away from the road for the outcrop to jut
 * from, plus a basin for the plunge pool. The `gate` term is what keeps every
 * waterfall off the road and its verge.
 */
function carveWaterfall(plan: WaterfallPlan, distance: number, lateral: number): TerrainCarve {
  const inward = lateral * plan.side;
  if (inward <= 0) return NO_CARVE;
  const gate = smoothstep(inward, LANDMARK_ROAD_CLEARANCE - 2.5, LANDMARK_ROAD_CLEARANCE + 2.5);
  if (gate <= 0) return NO_CARVE;

  const offset = Math.abs(distance - plan.center);
  const alongCliff = 1 - smoothstep(offset / (plan.cliffHalfLength + 14), 0.5, 1);
  const alongPool = 1 - smoothstep(offset / (plan.poolRadius * 2.4), 0.3, 1);
  const flatten = gate * Math.max(alongCliff, alongPool);
  if (flatten <= 0) return NO_CARVE;

  const hillside = plan.cliffHeight * 0.42
    * smoothstep(inward, plan.cliffOffset - 2, plan.cliffOffset + plan.cliffDepth)
    * alongCliff;
  const basin = -plan.poolDepth
    * (1 - smoothstep(Math.abs(inward - Math.abs(plan.poolLateral)) / (plan.poolRadius * 1.55), 0.25, 1.1))
    * alongPool;

  return { heightDelta: gate * (hillside + basin), flatten, plan };
}
