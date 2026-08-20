import * as THREE from "three";

const ROAD_BASE = new THREE.Color(0x5c6058);
const ROAD_VARY = new THREE.Color(0x6d7268);
const SHOULDER_BASE = new THREE.Color(0xb08a56);
const SHOULDER_VARY = new THREE.Color(0x9a7748);

export function roadPoint(distance: number): THREE.Vector3 {
  // Two slow terms carry the long-range meander; a third, mid-frequency term
  // layers in tighter, more frequent bends so the road reads as actual
  // cornering rather than a gentle drift. Its own amplitude breathes over a
  // very long period (`cornerIntensity`), so some stretches curve hard while
  // others relax back toward the lazy S-curve — variety rather than a
  // uniformly wiggly line.
  const cornerIntensity = 0.55 + Math.sin(distance * 0.00095) * 0.45;
  const x =
    Math.sin(distance * 0.0085) * 16 +
    Math.sin(distance * 0.0027 + 1.1) * 30 +
    Math.sin(distance * 0.0141 + 2.3) * 24 * cornerIntensity;
  // Same idea as `cornerIntensity` above, applied to elevation: a mid-frequency
  // rolling-hill term layered on the slow base climb/descent, so the grade
  // actually pitches up and down as you ride instead of drifting gently.
  const hillIntensity = 0.55 + Math.sin(distance * 0.0007 + 2.4) * 0.45;
  const y =
    Math.sin(distance * 0.0052 + 0.4) * 3.2 +
    Math.sin(distance * 0.00165) * 7 +
    Math.sin(distance * 0.0195 + 0.7) * 5 * hillIntensity;
  return new THREE.Vector3(x, y, -distance);
}

export function terrainWave(x: number, z: number): number {
  return Math.sin(x * 0.055 + z * 0.018) * 1.8 + Math.sin(x * 0.021 - z * 0.012) * 2.6;
}

export function roadColor(distance: number): THREE.Color {
  const noise = seededNoise(Math.floor(distance * 0.35), 7);
  return ROAD_BASE.clone().lerp(ROAD_VARY, noise);
}

export function shoulderColor(distance: number, side: number): THREE.Color {
  const noise = seededNoise(Math.floor(distance * 0.22), side * 3 + 11);
  return SHOULDER_BASE.clone().lerp(SHOULDER_VARY, noise);
}

export function seededNoise(x: number, z: number): number {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
