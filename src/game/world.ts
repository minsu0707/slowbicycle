import * as THREE from "three";

const CHUNK_LENGTH = 180;
const ROAD_HALF_WIDTH = 2.7;
const SEGMENTS = 45;

export interface RoadSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  yaw: number;
  slope: number;
}

export class EndlessWorld {
  readonly group = new THREE.Group();
  private chunks = new Map<number, THREE.Group>();
  private quality: "low" | "high" = "high";
  private roadMaterial = new THREE.MeshStandardMaterial({ color: 0x5f655e, roughness: 0.98 });
  private shoulderMaterial = new THREE.MeshStandardMaterial({ color: 0xb9905d, roughness: 1 });
  private terrainMaterial = new THREE.MeshStandardMaterial({ color: 0x75865b, roughness: 1, flatShading: true });
  private lineMaterial = new THREE.MeshStandardMaterial({ color: 0xf1dfb8, roughness: 0.9 });

  constructor(scene: THREE.Scene) {
    this.group.name = "endless-world";
    scene.add(this.group);
    this.addDistantLandscape();
  }

  setQuality(quality: "low" | "high"): void {
    if (this.quality === quality) return;
    this.quality = quality;
    for (const chunk of this.chunks.values()) this.group.remove(chunk);
    this.chunks.clear();
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

  roadHalfWidth(): number {
    return ROAD_HALF_WIDTH;
  }

  private makeChunk(index: number): THREE.Group {
    const chunk = new THREE.Group();
    chunk.name = `road-chunk-${index}`;
    const start = index * CHUNK_LENGTH;
    chunk.add(this.makeStrip(start, ROAD_HALF_WIDTH + 0.8, this.shoulderMaterial, -0.055));
    chunk.add(this.makeStrip(start, ROAD_HALF_WIDTH, this.roadMaterial, 0));
    chunk.add(this.makeTerrain(start));
    chunk.add(this.makeRoadDetails(start));
    chunk.add(this.makeProps(index, start));
    return chunk;
  }

  private makeStrip(start: number, halfWidth: number, material: THREE.Material, yOffset: number): THREE.Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
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
        uvs.push(sign < 0 ? 0 : 1, i / SEGMENTS * 9);
      }
      if (i < SEGMENTS) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  private makeTerrain(start: number): THREE.Mesh {
    const across = this.quality === "high" ? 12 : 6;
    const along = this.quality === "high" ? 30 : 16;
    const width = 150;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let z = 0; z <= along; z += 1) {
      const s = start + (z / along) * CHUNK_LENGTH;
      const center = roadPoint(s);
      const tangent = roadPoint(s + 1).sub(center).normalize();
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      for (let x = 0; x <= across; x += 1) {
        const offset = (x / across - 0.5) * width;
        const point = center.clone().addScaledVector(side, offset);
        const edgeDrop = Math.min(Math.abs(offset) / 34, 1) * -1.2;
        point.y += edgeDrop + terrainWave(point.x, point.z) * Math.min(Math.abs(offset) / 12, 1) - 0.12;
        positions.push(point.x, point.y, point.z);
        const tint = 0.78 + seededNoise(Math.floor(point.x * 0.04), Math.floor(point.z * 0.04)) * 0.2;
        colors.push(0.43 * tint, 0.52 * tint, 0.32 * tint);
      }
    }
    for (let z = 0; z < along; z += 1) {
      for (let x = 0; x < across; x += 1) {
        const a = z * (across + 1) + x;
        indices.push(a, a + across + 1, a + 1, a + 1, a + across + 1, a + across + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = this.terrainMaterial.clone();
    material.vertexColors = true;
    const mesh = new THREE.Mesh(geometry, material);
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
      if (random() > 0.2) {
        const tree = makeTree(0.7 + random() * 1.4, random());
        tree.position.copy(position);
        tree.rotation.y = random() * Math.PI * 2;
        props.add(tree);
      } else {
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.45 + random() * 0.8, 0),
          new THREE.MeshStandardMaterial({ color: 0x8e887a, roughness: 1, flatShading: true }),
        );
        rock.scale.y = 0.55;
        rock.position.copy(position);
        rock.castShadow = true;
        props.add(rock);
      }
    }
    return props;
  }

  private addDistantLandscape(): void {
    const mountainMaterial = new THREE.MeshStandardMaterial({ color: 0x5d7166, roughness: 1, flatShading: true });
    for (let i = 0; i < 12; i += 1) {
      const mountain = new THREE.Mesh(new THREE.ConeGeometry(32 + (i % 4) * 11, 36 + (i % 5) * 8, 7), mountainMaterial);
      const side = i % 2 ? 1 : -1;
      mountain.position.set(side * (95 + (i % 3) * 35), 9, -i * 95 + 120);
      mountain.rotation.y = i * 1.7;
      this.group.add(mountain);
    }
  }

  private disposeChunk(chunk: THREE.Group): void {
    this.group.remove(chunk);
    chunk.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

export function roadPoint(distance: number): THREE.Vector3 {
  const x = Math.sin(distance * 0.0085) * 16 + Math.sin(distance * 0.0027 + 1.1) * 30;
  const y = Math.sin(distance * 0.0052 + 0.4) * 3.2 + Math.sin(distance * 0.00165) * 7;
  return new THREE.Vector3(x, y, -distance);
}

function terrainWave(x: number, z: number): number {
  return Math.sin(x * 0.055 + z * 0.018) * 1.8 + Math.sin(x * 0.021 - z * 0.012) * 2.6;
}

function makeTree(scale: number, variant: number): THREE.Group {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13 * scale, 0.2 * scale, 1.8 * scale, 6),
    new THREE.MeshStandardMaterial({ color: 0x6a4f39, roughness: 1 }),
  );
  trunk.position.y = 0.9 * scale;
  const crownColor = variant > 0.58 ? 0x8b8a4f : variant > 0.25 ? 0x486849 : 0x38594b;
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.9 * scale, 1),
    new THREE.MeshStandardMaterial({ color: crownColor, roughness: 1, flatShading: true }),
  );
  crown.scale.set(1, 1.35, 1);
  crown.position.y = 2.15 * scale;
  trunk.castShadow = crown.castShadow = false;
  tree.add(trunk, crown);
  return tree;
}

function seededNoise(x: number, z: number): number {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
