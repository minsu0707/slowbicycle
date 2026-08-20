import * as THREE from "three";
import { mulberry32, roadColor, roadPoint, seededNoise, shoulderColor, terrainWave } from "./procedural";

const CHUNK_LENGTH = 180;
const ROAD_HALF_WIDTH = 2.7;
const SEGMENTS = 45;
const FAR_LENGTH = 260;

export interface RoadSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  yaw: number;
  slope: number;
}

const SHOULDER_HALF_WIDTH = ROAD_HALF_WIDTH + 0.8;

/** Height of the visible riding surface at a road-relative position. */
export function groundHeight(distance: number, lateral: number): number {
  const center = roadPoint(distance);
  const absoluteLateral = Math.abs(lateral);
  if (absoluteLateral <= ROAD_HALF_WIDTH) return center.y;
  if (absoluteLateral <= SHOULDER_HALF_WIDTH) return center.y - 0.055;

  return terrainHeight(distance, lateral);
}

/** Terrain stays slightly below the road until it clears the shoulder. */
function terrainHeight(distance: number, lateral: number): number {
  const center = roadPoint(distance);
  const absoluteLateral = Math.abs(lateral);
  const tangent = roadPoint(distance + 0.5).sub(center).normalize();
  const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
  const point = center.clone().addScaledVector(side, lateral);
  const terrainBlend = THREE.MathUtils.smoothstep(absoluteLateral, SHOULDER_HALF_WIDTH, 15);
  const edgeDrop = -1.2 * THREE.MathUtils.clamp((absoluteLateral - SHOULDER_HALF_WIDTH) / 30.5, 0, 1);
  return center.y + edgeDrop + terrainWave(point.x, point.z) * terrainBlend - 0.12;
}

type PreloadJob = { kind: "near" | "far"; index: number };

// Shared, reused materials — prop instances differ only by geometry/transform,
// so every tree/rock/flower of a kind draws with the same material rather than
// minting a fresh one per instance.
const TRUNK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x6a4f39, roughness: 1 });
const CROWN_MATERIALS = [
  new THREE.MeshStandardMaterial({ color: 0x8b8a4f, roughness: 1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x486849, roughness: 1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x38594b, roughness: 1, flatShading: true }),
];
const BUSH_MATERIALS = [
  new THREE.MeshStandardMaterial({ color: 0x5e7a44, roughness: 1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x4c6a3c, roughness: 1, flatShading: true }),
];
const ROCK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8e887a, roughness: 1, flatShading: true });
const FENCE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x7c5a3d, roughness: 1 });
const LAMP_POLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.8, metalness: 0.2 });
const LAMP_GLOW_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffdca0, fog: false });
const STEM_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x5c7a4a, roughness: 1 });
const BLOOM_MATERIALS = [
  new THREE.MeshStandardMaterial({ color: 0xf4c94f, roughness: 0.9, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xe98fae, roughness: 0.9, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xf6efe3, roughness: 0.9, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xd98fd0, roughness: 0.9, flatShading: true }),
];

// Kept close in depth/saturation to the tree-crown materials below: under the
// scene's strong warm lighting, lighter/less-saturated greens wash out toward
// tan (verified against a render) — these darker, more saturated tones hold.
const GRASS_A = new THREE.Color(0x3c5530);
const GRASS_B = new THREE.Color(0x5c7a3e);
const WILDFLOWER = new THREE.Color(0xf2e2a0);
const LAVENDER = new THREE.Color(0xcf8fae);
const HAZE = new THREE.Color(0xd9b98a);
const HILL_TOP = new THREE.Color(0x5e7a3e);
const HILL_BASE = new THREE.Color(0x2e3a1e);
const CLOUD_TOP = new THREE.Color(0xfff8ee);
const CLOUD_BASE = new THREE.Color(0xe3a980);

let mistTexture: THREE.Texture | null = null;

/** A small radial-gradient texture, generated once and reused for every ground-mist patch. */
function getMistTexture(): THREE.Texture {
  if (mistTexture) return mistTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,0.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  mistTexture = new THREE.CanvasTexture(canvas);
  return mistTexture;
}

export class EndlessWorld {
  readonly group = new THREE.Group();
  private chunks = new Map<number, THREE.Group>();
  private farChunks = new Map<number, THREE.Group>();
  private preloadQueue: PreloadJob[] = [];
  private preloadKeys = new Set<string>();
  private preloadHandle?: number;
  private quality: "low" | "high" = "high";
  private roadMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, vertexColors: true });
  private shoulderMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true });
  private terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
  });
  private lineMaterial = new THREE.MeshStandardMaterial({ color: 0xf1dfb8, roughness: 0.9 });
  private hillMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  private cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, vertexColors: true });
  private mistMaterial = new THREE.MeshBasicMaterial({
    map: getMistTexture(),
    color: 0xf5ead6,
    transparent: true,
    depthWrite: false,
  });
  private skyMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  private starMaterial = new THREE.PointsMaterial({
    color: 0xe8efff,
    size: 0.72,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  private sky: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.group.name = "endless-world";
    scene.add(this.group);
    this.sky = this.buildSkyDome();
    this.sky.add(this.buildStars());
    this.group.add(this.sky);
  }

  setAtmosphere(skyTint: number, starOpacity: number): void {
    this.skyMaterial.color.setHex(skyTint);
    this.starMaterial.opacity = THREE.MathUtils.clamp(starOpacity, 0, 1);
    this.starMaterial.visible = this.starMaterial.opacity > 0.01;
  }

  setQuality(quality: "low" | "high"): void {
    if (this.quality === quality) return;
    this.cancelPreloads();
    this.quality = quality;
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    for (const chunk of this.farChunks.values()) this.disposeChunk(chunk);
    this.farChunks.clear();
  }

  update(distance: number): void {
    const current = Math.floor(distance / CHUNK_LENGTH);
    const ahead = this.quality === "high" ? 5 : 3;
    for (let index = current - 1; index <= current + ahead; index += 1) {
      if (!this.chunks.has(index)) {
        const chunk = this.makeChunk(index);
        this.chunks.set(index, chunk);
        this.group.add(chunk);
      }
    }
    for (const [index, chunk] of this.chunks) {
      if (index < current - 2 || index > current + ahead + 1) {
        this.disposeChunk(chunk);
        this.chunks.delete(index);
      }
    }
    this.enqueuePreload({ kind: "near", index: current + ahead + 1 });

    // Backdrop scenery (ridgelines, hills, clouds) recycles on its own, coarser
    // grid so the horizon keeps refilling no matter how far the ride goes.
    const farCurrent = Math.floor(distance / FAR_LENGTH);
    const farAhead = this.quality === "high" ? 3 : 2;
    for (let index = farCurrent - 1; index <= farCurrent + farAhead; index += 1) {
      if (!this.farChunks.has(index)) {
        const chunk = this.makeFarChunk(index);
        this.farChunks.set(index, chunk);
        this.group.add(chunk);
      }
    }
    for (const [index, chunk] of this.farChunks) {
      if (index < farCurrent - 2 || index > farCurrent + farAhead + 1) {
        this.disposeChunk(chunk);
        this.farChunks.delete(index);
      }
    }
    this.enqueuePreload({ kind: "far", index: farCurrent + farAhead + 1 });

    // The sky dome is a single fixed-radius shell — recenter it under the rider
    // each frame so it always encloses the view instead of being outrun.
    const center = roadPoint(distance);
    this.sky.position.set(center.x, 0, center.z);
  }

  sample(distance: number): RoadSample {
    const position = roadPoint(distance);
    const before = roadPoint(distance - 0.5);
    const after = roadPoint(distance + 0.5);
    const tangent = after.sub(before).normalize();
    return {
      position,
      tangent,
      yaw: Math.atan2(-tangent.x, -tangent.z),
      slope: tangent.y / Math.max(0.001, Math.hypot(tangent.x, tangent.z)),
    };
  }

  groundPosition(distance: number, lateral: number, target: THREE.Vector3): THREE.Vector3 {
    const sample = this.sample(distance);
    const side = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    target.copy(sample.position).addScaledVector(side, lateral);
    target.y = groundHeight(distance, lateral);
    return target;
  }

  roadHalfWidth(): number {
    return ROAD_HALF_WIDTH;
  }

  private buildSkyDome(): THREE.Mesh {
    const radius = 480;
    const geometry = new THREE.SphereGeometry(radius, 24, 16);
    const position = geometry.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const horizon = new THREE.Color(0xf3c98f);
    const mid = new THREE.Color(0xdba9a4);
    const zenith = new THREE.Color(0x6f83a8);
    const mixed = new THREE.Color();
    for (let i = 0; i < position.count; i += 1) {
      const t = THREE.MathUtils.clamp(position.getY(i) / radius, -0.2, 1);
      if (t < 0.24) mixed.copy(horizon).lerp(mid, THREE.MathUtils.smoothstep(t, -0.2, 0.24));
      else mixed.copy(mid).lerp(zenith, THREE.MathUtils.smoothstep(t, 0.24, 1));
      colors[i * 3] = mixed.r;
      colors[i * 3 + 1] = mixed.g;
      colors[i * 3 + 2] = mixed.b;
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geometry, this.skyMaterial);
    mesh.renderOrder = -10;
    mesh.name = "sky-dome";
    return mesh;
  }

  private buildStars(): THREE.Points {
    const random = mulberry32(913_741);
    const positions: number[] = [];
    for (let i = 0; i < 520; i += 1) {
      const azimuth = random() * Math.PI * 2;
      const elevation = 0.08 + random() * Math.PI * 0.42;
      const radius = 450 + random() * 8;
      positions.push(
        Math.cos(elevation) * Math.cos(azimuth) * radius,
        Math.sin(elevation) * radius,
        Math.cos(elevation) * Math.sin(azimuth) * radius,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const stars = new THREE.Points(geometry, this.starMaterial);
    stars.name = "night-stars";
    stars.renderOrder = -9;
    return stars;
  }

  private makeChunk(index: number): THREE.Group {
    const chunk = new THREE.Group();
    chunk.name = `road-chunk-${index}`;
    const start = index * CHUNK_LENGTH;
    chunk.add(this.makeStrip(start, SHOULDER_HALF_WIDTH, this.shoulderMaterial, -0.055, shoulderColor));
    chunk.add(this.makeStrip(start, ROAD_HALF_WIDTH, this.roadMaterial, 0, (distance) => roadColor(distance)));
    chunk.add(this.makeTerrain(start));
    chunk.add(this.makeRoadDetails(start));
    chunk.add(this.makeProps(index, start));
    chunk.add(this.makeGroundDetail(index, start));
    chunk.add(this.makeFence(index, start));
    chunk.add(this.makeLamppost(index, start));
    const mist = this.makeMist(index, start);
    if (mist) chunk.add(mist);
    return chunk;
  }

  private makeStrip(
    start: number,
    halfWidth: number,
    material: THREE.Material,
    yOffset: number,
    paint: (s: number, sign: number) => THREE.Color,
  ): THREE.Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const s = start + (i / SEGMENTS) * CHUNK_LENGTH;
      const point = roadPoint(s);
      const next = roadPoint(s + 0.5);
      const tangent = next.sub(point).normalize();
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      for (const sign of [-1, 1]) {
        const vertex = point.clone().addScaledVector(side, halfWidth * sign);
        positions.push(vertex.x, vertex.y + yOffset, vertex.z);
        uvs.push(sign < 0 ? 0 : 1, (i / SEGMENTS) * 9);
        const tint = paint(s, sign);
        colors.push(tint.r, tint.g, tint.b);
      }
      if (i < SEGMENTS) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  private makeTerrain(start: number): THREE.Mesh {
    const along = this.quality === "high" ? 30 : 16;
    // Keep vertices at both shoulder edges so the terrain cannot interpolate
    // upward through the road while crossing it diagonally.
    const offsets = this.quality === "high"
      ? [-75, -55, -38, -25, -16, -10, -6, -SHOULDER_HALF_WIDTH, 0, SHOULDER_HALF_WIDTH, 6, 10, 16, 25, 38, 55, 75]
      : [-75, -35, -12, -SHOULDER_HALF_WIDTH, 0, SHOULDER_HALF_WIDTH, 12, 35, 75];
    const across = offsets.length - 1;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const mixed = new THREE.Color();
    for (let z = 0; z <= along; z += 1) {
      const s = start + (z / along) * CHUNK_LENGTH;
      const center = roadPoint(s);
      const tangent = roadPoint(s + 1).sub(center).normalize();
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      for (let x = 0; x <= across; x += 1) {
        const offset = offsets[x];
        const point = center.clone().addScaledVector(side, offset);
        point.y = terrainHeight(s, offset);
        positions.push(point.x, point.y, point.z);

        const grassMix = seededNoise(Math.floor(point.x * 0.04), Math.floor(point.z * 0.04));
        mixed.copy(GRASS_A).lerp(GRASS_B, grassMix);
        const speckle = seededNoise(Math.floor(point.x * 0.11) + 91, Math.floor(point.z * 0.11) + 91);
        if (speckle > 0.94) mixed.lerp(WILDFLOWER, 0.4);
        else if (speckle < 0.04) mixed.lerp(LAVENDER, 0.24);
        const haze = Math.min(Math.abs(offset) / 70, 1) * 0.24;
        mixed.lerp(HAZE, haze);

        colors.push(mixed.r, mixed.g, mixed.b);
      }
    }
    for (let z = 0; z < along; z += 1) {
      for (let x = 0; x < across; x += 1) {
        const a = z * (across + 1) + x;
        indices.push(a, a + 1, a + across + 1, a + 1, a + across + 2, a + across + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    mesh.receiveShadow = true;
    return mesh;
  }

  private makeRoadDetails(start: number): THREE.Group {
    const details = new THREE.Group();
    for (let s = start + 8; s < start + CHUNK_LENGTH; s += 12) {
      const sample = this.sample(s);
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 4.3), this.lineMaterial);
      dash.position.copy(sample.position).add(new THREE.Vector3(0, 0.035, 0));
      dash.rotation.y = sample.yaw;
      dash.receiveShadow = true;
      details.add(dash);
    }
    return details;
  }

  private makeProps(index: number, start: number): THREE.Group {
    const props = new THREE.Group();
    const random = mulberry32(index * 92821 + 91);
    const count = this.quality === "high" ? 15 : 8;
    for (let i = 0; i < count; i += 1) {
      const s = start + random() * CHUNK_LENGTH;
      const sample = this.sample(s);
      const side = random() > 0.5 ? 1 : -1;
      const offset = side * (7 + random() * 36);
      const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
      const position = sample.position.clone().addScaledVector(right, offset);
      position.y += terrainWave(position.x, position.z) - 0.05;

      const roll = random();
      let prop: THREE.Object3D;
      if (roll < 0.5) {
        prop = makeTree(0.7 + random() * 1.4, random());
      } else if (roll < 0.72) {
        prop = makeBush(0.8 + random() * 0.9, random());
      } else {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45 + random() * 0.8, 0), ROCK_MATERIAL);
        rock.scale.y = 0.5 + random() * 0.2;
        rock.castShadow = true;
        prop = rock;
      }
      prop.position.copy(position);
      prop.rotation.y = random() * Math.PI * 2;
      prop.rotation.z = (random() - 0.5) * 0.12;
      props.add(prop);
    }
    return props;
  }

  /** Roadside grass tufts and wildflowers — a nod to the design doc's "풀숲" (grass patches). */
  private makeGroundDetail(index: number, start: number): THREE.Group {
    const group = new THREE.Group();
    if (this.quality !== "high") return group;
    const random = mulberry32(index * 51737 + 5);
    const count = 9;
    for (let i = 0; i < count; i += 1) {
      const s = start + random() * CHUNK_LENGTH;
      const sample = this.sample(s);
      const side = random() > 0.5 ? 1 : -1;
      const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
      const offset = side * (ROAD_HALF_WIDTH + 0.5 + random() * 3.5);
      const position = sample.position.clone().addScaledVector(right, offset);
      position.y += terrainWave(position.x, position.z) - 0.03;

      const tuft = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.24, 5), STEM_MATERIAL);
      stem.position.y = 0.12;
      tuft.add(stem);
      if (random() > 0.45) {
        const bloom = new THREE.Mesh(
          new THREE.ConeGeometry(0.045, 0.09, 5),
          BLOOM_MATERIALS[Math.floor(random() * BLOOM_MATERIALS.length)],
        );
        bloom.position.y = 0.26;
        tuft.add(bloom);
      }
      tuft.position.copy(position);
      tuft.rotation.y = random() * Math.PI * 2;
      group.add(tuft);
    }
    return group;
  }

  /** Occasional wooden fence run along one shoulder — the design doc's "울타리". */
  private makeFence(index: number, start: number): THREE.Group {
    const group = new THREE.Group();
    if (this.quality !== "high") return group;
    const random = mulberry32(index * 60127 + 31);
    if (random() > 0.42) return group;
    const side = random() > 0.5 ? 1 : -1;
    const gap = 3.4;
    let previous: THREE.Vector3 | null = null;
    for (let s = start + random() * 5; s < start + CHUNK_LENGTH - 3; s += gap) {
      const sample = this.sample(s);
      const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
      const position = sample.position.clone().addScaledVector(right, side * (ROAD_HALF_WIDTH + 1.15));
      position.y += terrainWave(position.x, position.z);

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.06), FENCE_MATERIAL);
      post.position.copy(position).add(new THREE.Vector3(0, 0.31, 0));
      group.add(post);

      if (previous) {
        const mid = previous.clone().add(position).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.5, 0));
        const length = previous.distanceTo(position);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, length), FENCE_MATERIAL);
        rail.position.copy(mid);
        rail.lookAt(position.x, mid.y, position.z);
        group.add(rail);
      }
      previous = position;
    }
    return group;
  }

  /** A rare, softly glowing lamppost — the design doc's "드문 가로등". No real light, just a warm accent. */
  private makeLamppost(index: number, start: number): THREE.Group {
    const group = new THREE.Group();
    if (this.quality !== "high") return group;
    const random = mulberry32(index * 74219 + 43);
    if (random() > 0.12) return group;
    const side = random() > 0.5 ? 1 : -1;
    const s = start + 20 + random() * (CHUNK_LENGTH - 40);
    const sample = this.sample(s);
    const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const position = sample.position.clone().addScaledVector(right, side * (ROAD_HALF_WIDTH + 1.6));
    position.y += terrainWave(position.x, position.z);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 2.6, 6), LAMP_POLE_MATERIAL);
    pole.position.set(0, 1.3, 0);
    const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), LAMP_GLOW_MATERIAL);
    glow.position.set(0, 2.65, 0);
    group.add(pole, glow);
    group.position.copy(position);
    return group;
  }

  /** A soft ground-mist patch tucked into a low fold of terrain — atmosphere, used sparingly. */
  private makeMist(index: number, start: number): THREE.Mesh | null {
    if (this.quality !== "high" || index % 2 !== 0) return null;
    const random = mulberry32(index * 33119 + 71);
    const s = start + 30 + random() * (CHUNK_LENGTH - 60);
    const sample = this.sample(s);
    const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const side = random() > 0.5 ? 1 : -1;
    const position = sample.position.clone().addScaledVector(right, side * (16 + random() * 20));
    position.y += terrainWave(position.x, position.z) + 0.25;

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(28, 28), this.mistMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(position);
    return mesh;
  }

  private makeFarChunk(index: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `far-chunk-${index}`;
    const start = index * FAR_LENGTH;
    const center = roadPoint(start + FAR_LENGTH / 2);
    const random = mulberry32(index * 7349 + 17);

    this.addSplitRidge(group, start + FAR_LENGTH / 2 + 200, 340, 95, 0xcdb48f, 0xb0966c, random(), 30, 56);
    this.addSplitRidge(group, start + FAR_LENGTH / 2 + 90, 250, 62, 0x6f8156, 0x455636, random(), 16, 32);

    const hillCount = this.quality === "high" ? 3 : 2;
    for (let i = 0; i < hillCount; i += 1) {
      const distance = start + 35 + random() * (FAR_LENGTH - 70);
      const sample = this.sample(distance);
      const right = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
      const side = random() > 0.5 ? 1 : -1;
      const position = sample.position.clone().addScaledVector(right, side * (90 + random() * 140));
      const radius = 10 + random() * 14;
      position.y += terrainWave(position.x, position.z) - radius * 0.28 - 1;
      group.add(this.makeHillMound(position, radius));
    }

    const cloudCount = this.quality === "high" ? 3 : 2;
    for (let i = 0; i < cloudCount; i += 1) {
      const x = center.x + (random() - 0.5) * 500;
      const y = 60 + random() * 55;
      const z = center.z - 120 - random() * 220;
      group.add(this.makeCloudCluster(new THREE.Vector3(x, y, z), 6 + random() * 6, random));
    }

    return group;
  }

  private makeRidge(
    centerX: number,
    z: number,
    width: number,
    colorTop: number,
    colorBase: number,
    seed: number,
    minHeight: number,
    maxHeight: number,
    valleyEdge?: "left" | "right",
  ): THREE.Mesh {
    const segments = 18;
    const random = mulberry32(Math.floor(seed * 1_000_000) + 11);
    const phase1 = random() * Math.PI * 2;
    const phase2 = random() * Math.PI * 2;
    const freq1 = 1.2 + random() * 0.9;
    const freq2 = 2.6 + random() * 1.8;
    const top = new THREE.Color(colorTop);
    const base = new THREE.Color(colorBase);
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const x = centerX - width / 2 + t * width;
      const wave = Math.sin(t * Math.PI * freq1 + phase1) * 0.5 + Math.sin(t * Math.PI * freq2 + phase2) * 0.25 + 0.5;
      let height = minHeight + THREE.MathUtils.clamp(wave, 0, 1) * (maxHeight - minHeight);
      if (valleyEdge) {
        const distanceFromValley = valleyEdge === "left" ? t : 1 - t;
        const taper = THREE.MathUtils.smoothstep(distanceFromValley, 0, 0.3);
        height = THREE.MathUtils.lerp(2, height, taper);
      }
      positions.push(x, height, z);
      colors.push(top.r, top.g, top.b);
      positions.push(x, -20, z);
      colors.push(base.r, base.g, base.b);
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    return new THREE.Mesh(geometry, this.hillMaterial);
  }

  private addSplitRidge(
    group: THREE.Group,
    distance: number,
    sideWidth: number,
    valleyHalfWidth: number,
    colorTop: number,
    colorBase: number,
    seed: number,
    minHeight: number,
    maxHeight: number,
  ): void {
    const road = roadPoint(distance);
    const z = road.z;
    const offset = valleyHalfWidth + sideWidth / 2;
    group.add(
      this.makeRidge(road.x - offset, z, sideWidth, colorTop, colorBase, seed, minHeight, maxHeight, "right"),
      this.makeRidge(road.x + offset, z, sideWidth, colorTop, colorBase, seed + 0.417, minHeight, maxHeight, "left"),
    );
  }

  private makeHillMound(position: THREE.Vector3, radius: number): THREE.Mesh {
    const geometry = new THREE.IcosahedronGeometry(radius, 1);
    geometry.scale(1, 0.42, 1);
    paintByHeight(geometry, HILL_TOP, HILL_BASE);
    const mesh = new THREE.Mesh(geometry, this.hillMaterial);
    mesh.position.copy(position);
    return mesh;
  }

  private makeCloudCluster(position: THREE.Vector3, scale: number, random: () => number): THREE.Group {
    const group = new THREE.Group();
    const puffs = 3 + Math.floor(random() * 2);
    for (let i = 0; i < puffs; i += 1) {
      const radius = (0.5 + random() * 0.55) * scale;
      const geometry = new THREE.IcosahedronGeometry(radius, 0);
      geometry.scale(1.3, 0.6, 1.15);
      paintByHeight(geometry, CLOUD_TOP, CLOUD_BASE);
      const puff = new THREE.Mesh(geometry, this.cloudMaterial);
      puff.position.set((random() - 0.5) * scale * 1.7, (random() - 0.5) * scale * 0.35, (random() - 0.5) * scale * 1.2);
      group.add(puff);
    }
    group.position.copy(position);
    return group;
  }

  private enqueuePreload(job: PreloadJob): void {
    const chunks = job.kind === "near" ? this.chunks : this.farChunks;
    const key = `${job.kind}:${job.index}`;
    if (chunks.has(job.index) || this.preloadKeys.has(key)) return;
    this.preloadQueue.push(job);
    this.preloadKeys.add(key);
    this.schedulePreload();
  }

  private schedulePreload(): void {
    if (this.preloadHandle !== undefined || this.preloadQueue.length === 0) return;
    const run = () => {
      this.preloadHandle = undefined;
      const job = this.preloadQueue.shift();
      if (!job) return;
      const key = `${job.kind}:${job.index}`;
      const chunks = job.kind === "near" ? this.chunks : this.farChunks;
      if (!chunks.has(job.index)) {
        const chunk = job.kind === "near" ? this.makeChunk(job.index) : this.makeFarChunk(job.index);
        chunks.set(job.index, chunk);
        this.group.add(chunk);
      }
      this.preloadKeys.delete(key);
      this.schedulePreload();
    };

    const idleApi = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    };
    this.preloadHandle = idleApi.requestIdleCallback
      ? idleApi.requestIdleCallback(run, { timeout: 700 })
      : window.setTimeout(run, 16);
  }

  private cancelPreloads(): void {
    if (this.preloadHandle !== undefined) {
      const idleApi = window as unknown as { cancelIdleCallback?: (handle: number) => void };
      if (idleApi.cancelIdleCallback) idleApi.cancelIdleCallback(this.preloadHandle);
      else window.clearTimeout(this.preloadHandle);
    }
    this.preloadHandle = undefined;
    this.preloadQueue = [];
    this.preloadKeys.clear();
  }

  private disposeChunk(chunk: THREE.Group): void {
    this.group.remove(chunk);
    chunk.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

/** Tints a geometry's vertex colors from base (low) to top (high) along its own bounding box. */
function paintByHeight(geometry: THREE.BufferGeometry, topColor: THREE.Color, baseColor: THREE.Color): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  const range = Math.max(0.001, box.max.y - box.min.y);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const mixed = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const t = (position.getY(i) - box.min.y) / range;
    mixed.copy(baseColor).lerp(topColor, t);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}

function makeTree(scale: number, variant: number): THREE.Group {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * scale, 0.2 * scale, 1.8 * scale, 6), TRUNK_MATERIAL);
  trunk.position.y = 0.9 * scale;
  const crownMaterial = variant > 0.58 ? CROWN_MATERIALS[0] : variant > 0.25 ? CROWN_MATERIALS[1] : CROWN_MATERIALS[2];
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 * scale, 1), crownMaterial);
  crown.scale.set(1, 1.35, 1);
  crown.position.y = 2.15 * scale;
  trunk.castShadow = crown.castShadow = false;
  tree.add(trunk, crown);
  return tree;
}

function makeBush(scale: number, variant: number): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(0.55 * scale, 0);
  geometry.scale(1.25, 0.7, 1.25);
  const material = BUSH_MATERIALS[variant > 0.5 ? 0 : 1];
  const bush = new THREE.Mesh(geometry, material);
  bush.position.y = 0.35 * scale;
  return bush;
}
