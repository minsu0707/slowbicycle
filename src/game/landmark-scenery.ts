import * as THREE from "three";
import { mulberry32, roadPoint } from "./procedural";
import {
  DECK_TOP_DROP,
  bridgeFloorY,
  bridgeWaterY,
  landmarksInRange,
  waterfallCrestY,
  waterfallPoolY,
  type BridgePlan,
  type LandmarkPlan,
  type WaterfallPlan,
} from "./landmarks";

// ---------------------------------------------------------------------------
// Landmark scenery: turns a plan from `landmarks.ts` into a THREE.Group.
//
// Two conventions this file sticks to, both inherited from `world.ts`:
//
// 1. Every vertex is placed in world space from a road-relative frame
//    (`roadPoint` + its lateral axis), never with a group-level rotation. A
//    60m bridge deck sits on a curve, and a single rotated box would drift off
//    the road exactly where it is most obvious.
// 2. Materials are module-level and shared; geometries are per instance. That
//    is precisely what `EndlessWorld.disposeChunk` expects — it walks the chunk
//    disposing child geometries and leaves materials alone — so a landmark can
//    be built and thrown away as often as its chunk without leaking or killing
//    a material another chunk still draws with.
//
// Repeated props (rail posts, rocks, reeds, foam, mist) are baked into one
// merged geometry per kind rather than one mesh each, which keeps a whole
// landmark inside ~a dozen draw calls. Merged geometry — unlike an
// InstancedMesh, whose instance buffer `disposeChunk` would not free — is
// released completely by the single `geometry.dispose()` the world already does.
//
// No bitmap assets: every surface is vertex-coloured or flat-shaded, and
// nothing here touches `document`, so this module builds fine under vitest.
// ---------------------------------------------------------------------------

export type Quality = "low" | "high";

export interface LandmarkSceneryOptions {
  quality?: Quality;
}

const ROCK_TOP = new THREE.Color(0x9a9384);
const ROCK_BASE = new THREE.Color(0x4a463e);
const DECK_TOP = new THREE.Color(0xb9ac95);
const DECK_BASE = new THREE.Color(0x6d6455);

const MASONRY_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1,
  flatShading: true,
  vertexColors: true,
});
// Double-sided: the cliff outcrop is mirrored for road-left waterfalls, which
// reverses its triangle winding. Front-facing lighting would invert with it.
const ROCK_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1,
  flatShading: true,
  vertexColors: true,
  side: THREE.DoubleSide,
});
const RAIL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8d6a45, roughness: 0.85 });
const WATER_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x3f7d92,
  roughness: 0.22,
  metalness: 0.12,
  transparent: true,
  opacity: 0.86,
  side: THREE.DoubleSide,
});
// Layered sheets of falling water: back sheets are darker and more solid, front
// sheets brighter and thinner, so the fall reads as depth rather than a decal.
const FALL_MATERIALS = [
  new THREE.MeshStandardMaterial({
    color: 0x7fb6c6,
    roughness: 0.3,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  new THREE.MeshStandardMaterial({
    color: 0xc3e6ef,
    roughness: 0.25,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  new THREE.MeshStandardMaterial({
    color: 0xf4fbfd,
    roughness: 0.2,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
];
const FOAM_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xeef7f8,
  roughness: 0.7,
  flatShading: true,
  transparent: true,
  opacity: 0.82,
});
const MIST_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xeef6f7,
  transparent: true,
  opacity: 0.14,
  depthWrite: false,
});
const REED_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4e6b3a, roughness: 1, flatShading: true });

/** All materials this module shares, exposed so tests can assert reuse. */
export const LANDMARK_MATERIALS: readonly THREE.Material[] = [
  MASONRY_MATERIAL,
  ROCK_MATERIAL,
  RAIL_MATERIAL,
  WATER_MATERIAL,
  ...FALL_MATERIALS,
  FOAM_MATERIAL,
  MIST_MATERIAL,
  REED_MATERIAL,
];

// ---------------------------------------------------------------------------
// Road-relative frames and geometry helpers
// ---------------------------------------------------------------------------

/** Lateral (road-right) axis at a distance along the road. */
function rightAt(distance: number, target: THREE.Vector3): THREE.Vector3 {
  const back = roadPoint(distance - 0.5);
  const ahead = roadPoint(distance + 0.5);
  return target.set(-(ahead.z - back.z), 0, ahead.x - back.x).normalize();
}

const scratchRight = new THREE.Vector3();

/** World-space point at (distance along road, lateral offset, height offset). */
function roadFramePoint(distance: number, lateral: number, yOffset: number): THREE.Vector3 {
  const point = roadPoint(distance);
  rightAt(distance, scratchRight);
  point.addScaledVector(scratchRight, lateral);
  point.y += yOffset;
  return point;
}

/** Yaw matching the convention `world.ts` uses for road-aligned boxes. */
function yawAt(distance: number): number {
  const back = roadPoint(distance - 0.5);
  const ahead = roadPoint(distance + 0.5);
  return Math.atan2(-(ahead.x - back.x), -(ahead.z - back.z));
}

interface RibbonOptions {
  from: number;
  to: number;
  segments: number;
  /** Lateral centre of the ribbon (signed). */
  lateral: number;
  halfWidth: number;
  /** Height offsets relative to the road surface at each station. */
  top: number;
  bottom: number;
  topColor: THREE.Color;
  baseColor: THREE.Color;
}

/**
 * A closed box-section ribbon swept along the road — the deck, its curbs and
 * its rails are all this shape at different sizes. Both the top and the two
 * sides are real faces, so the deck shows an honest thickness in profile
 * instead of reading as a painted stripe.
 */
function ribbonGeometry(options: RibbonOptions): THREE.BufferGeometry {
  const { from, to, segments, lateral, halfWidth, top, bottom, topColor, baseColor } = options;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const s = from + ((to - from) * i) / segments;
    for (const [offset, height, tint] of [
      [lateral - halfWidth, top, topColor],
      [lateral + halfWidth, top, topColor],
      [lateral - halfWidth, bottom, baseColor],
      [lateral + halfWidth, bottom, baseColor],
    ] as Array<[number, number, THREE.Color]>) {
      const point = roadFramePoint(s, offset, height);
      positions.push(point.x, point.y, point.z);
      colors.push(tint.r, tint.g, tint.b);
    }
    if (i < segments) {
      const base = i * 4;
      const next = base + 4;
      indices.push(
        // top
        base, base + 1, next, base + 1, next + 1, next,
        // bottom
        base + 2, next + 2, base + 3, base + 3, next + 2, next + 3,
        // left flank
        base, next, base + 2, next, next + 2, base + 2,
        // right flank
        base + 1, base + 3, next + 1, next + 1, base + 3, next + 3,
      );
    }
  }
  const last = segments * 4;
  indices.push(0, 2, 1, 1, 2, 3, last, last + 1, last + 2, last + 1, last + 3, last + 2);

  return finishGeometry(positions, colors, indices);
}

function finishGeometry(positions: number[], colors: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Tints a geometry from base (low) to top (high) across its bounding box. */
function paintByHeight(geometry: THREE.BufferGeometry, topColor: THREE.Color, baseColor: THREE.Color): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  const span = Math.max(0.001, box.max.y - box.min.y);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const mixed = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    mixed.copy(baseColor).lerp(topColor, (position.getY(i) - box.min.y) / span);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}

/**
 * Bakes one template shape into a single geometry, once per transform. One mesh
 * instead of N, and one `geometry.dispose()` frees the lot — see the note at
 * the top of the file about why this is preferred over InstancedMesh here.
 */
function mergeInstances(template: THREE.BufferGeometry, matrices: THREE.Matrix4[]): THREE.BufferGeometry {
  const source = template.index ? template.toNonIndexed() : template;
  const sourcePosition = source.attributes.position;
  const sourceNormal = source.attributes.normal;
  const perInstance = sourcePosition.count;
  const positions = new Float32Array(matrices.length * perInstance * 3);
  const normals = new Float32Array(matrices.length * perInstance * 3);
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  let cursor = 0;
  for (const matrix of matrices) {
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < perInstance; i += 1) {
      vertex.fromBufferAttribute(sourcePosition, i).applyMatrix4(matrix);
      positions[cursor] = vertex.x;
      positions[cursor + 1] = vertex.y;
      positions[cursor + 2] = vertex.z;
      if (sourceNormal) {
        normal.fromBufferAttribute(sourceNormal, i).applyNormalMatrix(normalMatrix).normalize();
        normals[cursor] = normal.x;
        normals[cursor + 1] = normal.y;
        normals[cursor + 2] = normal.z;
      }
      cursor += 3;
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (sourceNormal) merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  else merged.computeVertexNormals();

  if (source !== template) source.dispose();
  template.dispose();
  return merged;
}

const scratchQuaternion = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();

function placement(position: THREE.Vector3, yaw: number, tilt: number, scale: THREE.Vector3): THREE.Matrix4 {
  scratchEuler.set(tilt, yaw, tilt * 0.6);
  scratchQuaternion.setFromEuler(scratchEuler);
  return new THREE.Matrix4().compose(position, scratchQuaternion, scale);
}

/** A quad grid laid out in road-relative coordinates. */
function surfaceGeometry(
  stations: number[],
  laterals: number[],
  heightAt: (distance: number, lateral: number) => number,
  tint: THREE.Color,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = 0; j < laterals.length; j += 1) {
      const point = roadFramePoint(stations[i], laterals[j], 0);
      point.y = heightAt(stations[i], laterals[j]);
      positions.push(point.x, point.y, point.z);
      colors.push(tint.r, tint.g, tint.b);
    }
  }
  const stride = laterals.length;
  for (let i = 0; i < stations.length - 1; i += 1) {
    for (let j = 0; j < stride - 1; j += 1) {
      const a = i * stride + j;
      indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  }
  return finishGeometry(positions, colors, indices);
}

function spread(count: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(i / (count - 1));
  return values;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Scenery for one landmark plan, ready to add to a chunk. */
export function buildLandmarkScenery(plan: LandmarkPlan, options: LandmarkSceneryOptions = {}): THREE.Group {
  const quality = options.quality ?? "high";
  const group = plan.kind === "bridge" ? buildBridge(plan, quality) : buildWaterfall(plan, quality);
  group.name = `landmark-${plan.kind}-${plan.slot}`;
  return group;
}

/**
 * Every landmark whose centre falls in `[from, to)`, wrapped in one group —
 * the shape `EndlessWorld.makeChunk` wants. Empty stretches cost an empty
 * group, which is what the rest of the chunk builders already return.
 */
export function buildLandmarksIn(from: number, to: number, options: LandmarkSceneryOptions = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = "landmarks";
  for (const plan of landmarksInRange(from, to)) group.add(buildLandmarkScenery(plan, options));
  return group;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function buildBridge(plan: BridgePlan, quality: Quality): THREE.Group {
  const group = new THREE.Group();
  const random = mulberry32(plan.seed);
  const detailed = quality === "high";
  const start = plan.center - plan.halfSpan;
  const end = plan.center + plan.halfSpan;
  const deckBottom = -DECK_TOP_DROP - plan.deckThickness;
  const segments = detailed ? 20 : 12;

  const deck = new THREE.Mesh(
    ribbonGeometry({
      from: start,
      to: end,
      segments,
      lateral: 0,
      halfWidth: plan.deckHalfWidth,
      top: -DECK_TOP_DROP,
      bottom: deckBottom,
      topColor: DECK_TOP,
      baseColor: DECK_BASE,
    }),
    MASONRY_MATERIAL,
  );
  deck.receiveShadow = true;
  group.add(deck);

  // Curbs, rails and posts. The rails read as a continuous line from the
  // saddle, so they get their own swept ribbon rather than per-post segments.
  const postMatrices: THREE.Matrix4[] = [];
  for (const side of [-1, 1]) {
    const edge = side * (plan.deckHalfWidth - 0.24);
    group.add(
      new THREE.Mesh(
        ribbonGeometry({
          from: start,
          to: end,
          segments,
          lateral: edge,
          halfWidth: 0.24,
          top: -DECK_TOP_DROP + 0.26,
          bottom: -DECK_TOP_DROP,
          topColor: DECK_TOP,
          baseColor: DECK_BASE,
        }),
        MASONRY_MATERIAL,
      ),
    );
    group.add(
      new THREE.Mesh(
        ribbonGeometry({
          from: start,
          to: end,
          segments,
          lateral: edge,
          halfWidth: 0.06,
          top: -DECK_TOP_DROP + plan.railHeight,
          bottom: -DECK_TOP_DROP + plan.railHeight - 0.13,
          topColor: DECK_TOP,
          baseColor: DECK_BASE,
        }),
        RAIL_MATERIAL,
      ),
    );
    for (let s = start + 0.9; s < end; s += plan.postSpacing) {
      const position = roadFramePoint(s, edge, -DECK_TOP_DROP + plan.railHeight * 0.5 + 0.1);
      postMatrices.push(placement(position, yawAt(s), 0, scratchScale.set(1, 1, 1)));
    }
  }
  const postHeight = plan.railHeight * 0.9;
  group.add(
    new THREE.Mesh(
      mergeInstances(new THREE.BoxGeometry(0.11, postHeight, 0.11), postMatrices),
      RAIL_MATERIAL,
    ),
  );

  // Abutments: chunky blocks where the deck lands on the bank. The gorge carve
  // returns the ground to road level exactly at the deck ends, so these sit on
  // solid terrain and hide the seam between deck and hillside.
  for (const sign of [-1, 1]) {
    const inner = plan.center + sign * (plan.halfSpan - 3.5);
    const outer = plan.center + sign * (plan.halfSpan + 1.5);
    group.add(
      new THREE.Mesh(
        ribbonGeometry({
          from: Math.min(inner, outer),
          to: Math.max(inner, outer),
          segments: 3,
          lateral: 0,
          halfWidth: plan.deckHalfWidth + 0.7,
          top: -DECK_TOP_DROP - 0.02,
          bottom: -plan.gorgeDepth * 0.62,
          topColor: ROCK_TOP,
          baseColor: ROCK_BASE,
        }),
        MASONRY_MATERIAL,
      ),
    );
  }

  // Piers standing in the river, from under the deck down into the water.
  const floorY = bridgeFloorY(plan);
  for (const sign of [-1, 1]) {
    const s = plan.center + sign * plan.riverHalfLength * 0.82;
    const deckUnderside = roadPoint(s).y + deckBottom;
    const height = Math.max(1, deckUnderside - floorY + 0.6);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.7, height, 1.15), MASONRY_MATERIAL);
    paintByHeight(pier.geometry, ROCK_TOP, ROCK_BASE);
    pier.position.copy(roadFramePoint(s, 0, 0));
    pier.position.y = deckUnderside - height / 2 + 0.05;
    pier.rotation.y = yawAt(s);
    group.add(pier);
  }

  // The river itself: a broad, gently translucent sheet spanning the valley.
  const waterY = bridgeWaterY(plan);
  const stations = spread(detailed ? 6 : 4).map((t) => plan.center + (t * 2 - 1) * plan.riverHalfLength);
  const laterals = spread(detailed ? 9 : 5).map((t) => (t * 2 - 1) * plan.riverHalfWidth);
  const river = new THREE.Mesh(surfaceGeometry(stations, laterals, () => waterY, new THREE.Color(0xffffff)), WATER_MATERIAL);
  river.renderOrder = 1;
  group.add(river);

  // Shoreline dressing along the two banks where the water meets rising floor.
  const foamMatrices: THREE.Matrix4[] = [];
  const rockMatrices: THREE.Matrix4[] = [];
  const reedMatrices: THREE.Matrix4[] = [];
  const bankCount = detailed ? 9 : 5;
  for (const sign of [-1, 1]) {
    for (let i = 0; i < bankCount; i += 1) {
      const s = plan.center + sign * plan.riverHalfLength * (0.94 + random() * 0.1);
      const lateral = (random() * 2 - 1) * plan.riverHalfWidth * 0.72;
      const foam = roadFramePoint(s, lateral, 0);
      foam.y = waterY + 0.06;
      foamMatrices.push(placement(foam, random() * Math.PI, 0, scratchScale.set(1 + random() * 1.4, 0.3, 1 + random())));

      const rock = roadFramePoint(
        plan.center + sign * plan.riverHalfLength * (1.02 + random() * 0.22),
        (random() * 2 - 1) * plan.riverHalfWidth * 0.8,
        0,
      );
      rock.y = waterY - 0.15 + random() * 0.9;
      rockMatrices.push(
        placement(rock, random() * Math.PI * 2, (random() - 0.5) * 0.3, scratchScale.set(1 + random(), 0.6 + random() * 0.5, 1 + random())),
      );

      if (!detailed) continue;
      const reed = roadFramePoint(
        plan.center + sign * plan.riverHalfLength * (0.9 + random() * 0.3),
        (random() * 2 - 1) * plan.riverHalfWidth * 0.85,
        0,
      );
      reed.y = waterY + 0.28;
      reedMatrices.push(placement(reed, random() * Math.PI * 2, (random() - 0.5) * 0.25, scratchScale.set(1, 0.8 + random() * 1.1, 1)));
    }
  }
  addFoam(group, foamMatrices);
  addRocks(group, rockMatrices);
  addReeds(group, reedMatrices);

  return group;
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

function buildWaterfall(plan: WaterfallPlan, quality: Quality): THREE.Group {
  const group = new THREE.Group();
  const random = mulberry32(plan.seed);
  const detailed = quality === "high";
  const roadY = roadPoint(plan.center).y;
  const crestY = waterfallCrestY(plan);
  const poolY = waterfallPoolY(plan);

  group.add(buildCliff(plan, detailed ? 14 : 8, random));

  // Water arriving at the lip: a short chute across the plateau, then the lip
  // block it pours over.
  const lipLateral = plan.side * (plan.cliffOffset + 0.9);
  const chute = new THREE.Mesh(
    surfaceGeometry(
      [plan.center - plan.fallWidth * 0.4, plan.center + plan.fallWidth * 0.4],
      [lipLateral, plan.side * (plan.cliffOffset + 7)],
      (_, lateral) => crestY - 0.18 + Math.abs(lateral) * 0.02,
      new THREE.Color(0xffffff),
    ),
    WATER_MATERIAL,
  );
  chute.renderOrder = 1;
  group.add(chute);

  // Layered falling sheets. Each leans further out and widens as it drops, so
  // the stack reads as a volume of water rather than a flat cut-out.
  for (let layer = 0; layer < plan.fallSheets; layer += 1) {
    const t = plan.fallSheets === 1 ? 0 : layer / (plan.fallSheets - 1);
    const halfWidth = (plan.fallWidth / 2) * (0.6 + 0.4 * t);
    const geometry = surfaceGeometry(
      [plan.center - halfWidth, plan.center, plan.center + halfWidth],
      [0, 1, 2, 3],
      (_, step) => THREE.MathUtils.lerp(crestY - 0.1, poolY - 0.25, easeFall(step / 3)),
      new THREE.Color(0xffffff),
    );
    // The lateral axis of the sheet is its fall path, so rebuild those columns
    // by hand: each row of the grid steps a little further out over the pool.
    reprojectFall(geometry, plan, crestY, poolY, halfWidth, t);
    const sheet = new THREE.Mesh(geometry, FALL_MATERIALS[layer % FALL_MATERIALS.length]);
    sheet.renderOrder = 2 + layer;
    group.add(sheet);
  }

  // Plunge pool, sitting in the basin the terrain carve digs for it.
  const pool = new THREE.Mesh(new THREE.CircleGeometry(plan.poolRadius, detailed ? 18 : 10), WATER_MATERIAL);
  pool.geometry.rotateX(-Math.PI / 2);
  const poolCenter = roadFramePoint(plan.center, plan.poolLateral, 0);
  poolCenter.y = poolY;
  pool.position.copy(poolCenter);
  pool.renderOrder = 1;
  group.add(pool);

  // Impact foam, rim rocks, reeds and a breath of mist.
  const foamMatrices: THREE.Matrix4[] = [];
  const rockMatrices: THREE.Matrix4[] = [];
  const reedMatrices: THREE.Matrix4[] = [];
  const mistMatrices: THREE.Matrix4[] = [];
  const impactLateral = plan.side * (plan.cliffOffset - 1.1);

  const foamCount = detailed ? 10 : 5;
  for (let i = 0; i < foamCount; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = random() * plan.poolRadius * 0.75;
    const point = roadFramePoint(
      plan.center + Math.cos(angle) * radius,
      impactLateral - plan.side * Math.abs(Math.sin(angle)) * radius * 0.8,
      0,
    );
    point.y = poolY + 0.09;
    foamMatrices.push(
      placement(point, random() * Math.PI, 0, scratchScale.set(0.8 + random() * 1.5, 0.32, 0.8 + random() * 1.5)),
    );
  }

  const rockCount = detailed ? 11 : 6;
  for (let i = 0; i < rockCount; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = plan.poolRadius * (0.95 + random() * 0.5);
    const point = roadFramePoint(
      plan.center + Math.cos(angle) * radius,
      plan.poolLateral - plan.side * Math.sin(angle) * radius * 0.55,
      0,
    );
    point.y = poolY - 0.35 + random() * 0.8;
    rockMatrices.push(
      placement(
        point,
        random() * Math.PI * 2,
        (random() - 0.5) * 0.35,
        scratchScale.set(0.8 + random() * 1.5, 0.5 + random() * 0.7, 0.8 + random() * 1.5),
      ),
    );
  }

  if (detailed) {
    for (let i = 0; i < 12; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = plan.poolRadius * (1.05 + random() * 0.65);
      const point = roadFramePoint(
        plan.center + Math.cos(angle) * radius,
        plan.poolLateral - plan.side * Math.sin(angle) * radius * 0.6,
        0,
      );
      point.y = poolY + 0.2;
      reedMatrices.push(
        placement(point, random() * Math.PI * 2, (random() - 0.5) * 0.3, scratchScale.set(1, 0.8 + random() * 1.2, 1)),
      );
    }
    for (let i = 0; i < 5; i += 1) {
      const point = roadFramePoint(
        plan.center + (random() - 0.5) * plan.fallWidth * 2.4,
        impactLateral - plan.side * random() * 2.4,
        0,
      );
      point.y = poolY + 0.5 + random() * (roadY + plan.cliffHeight * 0.35 - poolY);
      mistMatrices.push(
        placement(point, random() * Math.PI, 0, scratchScale.set(1.6 + random() * 2.4, 1 + random() * 1.6, 1.6 + random() * 2.4)),
      );
    }
  }

  addFoam(group, foamMatrices);
  addRocks(group, rockMatrices);
  addReeds(group, reedMatrices);
  if (mistMatrices.length > 0) {
    const mist = new THREE.Mesh(mergeInstances(new THREE.IcosahedronGeometry(1, 0), mistMatrices), MIST_MATERIAL);
    mist.renderOrder = 6;
    group.add(mist);
  }

  return group;
}

/** Water accelerates as it falls, so the sheet's stations bunch up at the top. */
function easeFall(t: number): number {
  return t * t * (2 - t) * 0.5 + t * 0.5;
}

/**
 * `surfaceGeometry` lays out a grid in (distance, lateral); a falling sheet
 * instead needs (distance, height). This rewrites the four "lateral" columns
 * into a fall path that leans out over the pool and widens on the way down.
 */
function reprojectFall(
  geometry: THREE.BufferGeometry,
  plan: WaterfallPlan,
  crestY: number,
  poolY: number,
  halfWidth: number,
  layer: number,
): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const columns = 4;
  let index = 0;
  for (let row = 0; row < 3; row += 1) {
    const along = plan.center + (row - 1) * halfWidth;
    for (let column = 0; column < columns; column += 1) {
      const t = column / (columns - 1);
      const drop = easeFall(t);
      const lateral = plan.side * (plan.cliffOffset + 0.5 - layer * 0.3 - drop * (1.5 + layer * 0.7));
      // Ends of the sheet flare outward as the water spreads.
      const flare = 1 + drop * 0.45;
      const point = roadFramePoint(plan.center + (along - plan.center) * flare, lateral, 0);
      point.y = THREE.MathUtils.lerp(crestY - 0.08, poolY - 0.25, drop);
      position.setXYZ(index, point.x, point.y, point.z);
      index += 1;
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

/**
 * The cliff the water falls from: a jagged front face rising out of the pool
 * basin, capped by a slope that runs back into the hillside the terrain carve
 * raises. Both its foot and its back edge are deliberately buried so no seam
 * with the terrain mesh can open up.
 */
function buildCliff(plan: WaterfallPlan, segments: number, random: () => number): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const roadY = roadPoint(plan.center).y;

  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * 2 - 1;
    const s = plan.center + t * plan.cliffHalfLength;
    const taper = 1 - THREE.MathUtils.smoothstep(Math.abs(t), 0.5, 1);
    const jagLateral = (random() - 0.5) * 2.4;
    const jagHeight = (random() - 0.5) * 1.7;
    // Notch at the lip so the water leaves through a gap in the crest.
    const notch = 1 - THREE.MathUtils.smoothstep(Math.abs(t * plan.cliffHalfLength) / (plan.fallWidth * 0.8), 0, 1);

    const faceLateral = plan.side * (plan.cliffOffset + jagLateral * 0.5);
    const topLateral = plan.side * (plan.cliffOffset + 1.7 + jagLateral);
    const backLateral = plan.side * (plan.cliffOffset + plan.cliffDepth);
    const baseY = roadY - plan.poolDepth - 1.6;
    const topY = roadY + plan.cliffHeight * (0.34 + 0.66 * taper) + jagHeight * taper - notch * 1.8;
    const backY = roadY + plan.cliffHeight * 0.36;

    for (const [lateral, height] of [
      [faceLateral, baseY],
      [topLateral, topY],
      [backLateral, backY],
    ] as Array<[number, number]>) {
      const point = roadFramePoint(s, lateral, 0);
      positions.push(point.x, height, point.z);
    }

    if (i < segments) {
      const base = i * 3;
      const next = base + 3;
      indices.push(
        base, base + 1, next, base + 1, next + 1, next,
        base + 1, base + 2, next + 1, base + 2, next + 2, next + 1,
      );
    }
  }
  // Close both ends so the outcrop never shows a hollow shell from the side.
  const last = segments * 3;
  indices.push(0, 1, 2, last, last + 2, last + 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  paintByHeight(geometry, ROCK_TOP, ROCK_BASE);
  const cliff = new THREE.Mesh(geometry, ROCK_MATERIAL);
  cliff.name = "waterfall-cliff";
  return cliff;
}

function addFoam(group: THREE.Group, matrices: THREE.Matrix4[]): void {
  if (matrices.length === 0) return;
  const foam = new THREE.Mesh(mergeInstances(new THREE.IcosahedronGeometry(0.55, 0), matrices), FOAM_MATERIAL);
  foam.renderOrder = 5;
  group.add(foam);
}

function addRocks(group: THREE.Group, matrices: THREE.Matrix4[]): void {
  if (matrices.length === 0) return;
  const geometry = mergeInstances(new THREE.DodecahedronGeometry(0.55, 0), matrices);
  paintByHeight(geometry, ROCK_TOP, ROCK_BASE);
  group.add(new THREE.Mesh(geometry, ROCK_MATERIAL));
}

function addReeds(group: THREE.Group, matrices: THREE.Matrix4[]): void {
  if (matrices.length === 0) return;
  group.add(new THREE.Mesh(mergeInstances(new THREE.ConeGeometry(0.09, 1.1, 4), matrices), REED_MATERIAL));
}
