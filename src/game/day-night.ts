export const DAY_NIGHT_CYCLE_SECONDS = 8 * 60;

export interface AtmosphereState {
  progress: number;
  background: number;
  fog: number;
  skyTint: number;
  skyLight: number;
  groundLight: number;
  sunColor: number;
  sunIntensity: number;
  ambientIntensity: number;
  starOpacity: number;
  exposure: number;
  sunElevation: number;
  sunAzimuth: number;
  moonElevation: number;
  moonAzimuth: number;
}

type Keyframe = Omit<AtmosphereState, "progress" | "sunElevation" | "sunAzimuth" | "moonElevation" | "moonAzimuth"> & {
  at: number;
};

const KEYFRAMES: Keyframe[] = [
  { at: 0, background: 0xd69a72, fog: 0xc89572, skyTint: 0xeab08d, skyLight: 0xd7b5a3, groundLight: 0x3e4938, sunColor: 0xffb36d, sunIntensity: 0.8, ambientIntensity: 0.68, starOpacity: 0.12, exposure: 0.92 },
  { at: 0.12, background: 0xa8c5d8, fog: 0xc6cbb8, skyTint: 0xf4e2c9, skyLight: 0xcadceb, groundLight: 0x46543d, sunColor: 0xffd092, sunIntensity: 1.75, ambientIntensity: 1.08, starOpacity: 0, exposure: 1 },
  { at: 0.3, background: 0x8eb9d5, fog: 0xb9cab8, skyTint: 0xffffff, skyLight: 0xc9e1f2, groundLight: 0x43543b, sunColor: 0xffe0ad, sunIntensity: 2.2, ambientIntensity: 1.28, starOpacity: 0, exposure: 1.05 },
  { at: 0.48, background: 0xdfa16f, fog: 0xc9916c, skyTint: 0xffba86, skyLight: 0xe5b8a0, groundLight: 0x4b4537, sunColor: 0xff9a58, sunIntensity: 1.2, ambientIntensity: 0.82, starOpacity: 0.02, exposure: 0.98 },
  { at: 0.58, background: 0x41475f, fog: 0x5b5360, skyTint: 0x68708b, skyLight: 0x77819b, groundLight: 0x252d29, sunColor: 0xff8c59, sunIntensity: 0.2, ambientIntensity: 0.46, starOpacity: 0.42, exposure: 0.82 },
  { at: 0.7, background: 0x07111f, fog: 0x101929, skyTint: 0x27334f, skyLight: 0x53647d, groundLight: 0x151b1c, sunColor: 0x91a5c7, sunIntensity: 0.02, ambientIntensity: 0.25, starOpacity: 1, exposure: 0.72 },
  { at: 0.88, background: 0x0a1423, fog: 0x141d2d, skyTint: 0x2d3955, skyLight: 0x596b86, groundLight: 0x171d1d, sunColor: 0xa5b4cf, sunIntensity: 0.02, ambientIntensity: 0.27, starOpacity: 0.92, exposure: 0.74 },
  { at: 1, background: 0xd69a72, fog: 0xc89572, skyTint: 0xeab08d, skyLight: 0xd7b5a3, groundLight: 0x3e4938, sunColor: 0xffb36d, sunIntensity: 0.8, ambientIntensity: 0.68, starOpacity: 0.12, exposure: 0.92 },
];

export function sampleAtmosphere(rideSeconds: number): AtmosphereState {
  const safeSeconds = Number.isFinite(rideSeconds) ? Math.max(0, rideSeconds) : 0;
  // Begin in a bright morning rather than at the dawn boundary.
  const progress = (safeSeconds / DAY_NIGHT_CYCLE_SECONDS + 0.16) % 1;
  const upperIndex = Math.max(1, KEYFRAMES.findIndex((frame) => frame.at >= progress));
  const lower = KEYFRAMES[upperIndex - 1];
  const upper = KEYFRAMES[upperIndex];
  const mix = smooth((progress - lower.at) / Math.max(0.0001, upper.at - lower.at));

  return {
    progress,
    background: mixColor(lower.background, upper.background, mix),
    fog: mixColor(lower.fog, upper.fog, mix),
    skyTint: mixColor(lower.skyTint, upper.skyTint, mix),
    skyLight: mixColor(lower.skyLight, upper.skyLight, mix),
    groundLight: mixColor(lower.groundLight, upper.groundLight, mix),
    sunColor: mixColor(lower.sunColor, upper.sunColor, mix),
    sunIntensity: mixNumber(lower.sunIntensity, upper.sunIntensity, mix),
    ambientIntensity: mixNumber(lower.ambientIntensity, upper.ambientIntensity, mix),
    starOpacity: mixNumber(lower.starOpacity, upper.starOpacity, mix),
    exposure: mixNumber(lower.exposure, upper.exposure, mix),
    sunElevation: Math.sin(progress * Math.PI * 2),
    sunAzimuth: progress * Math.PI * 2 + 0.55,
    // The moon rides the same great circle half a cycle behind the sun, so
    // it climbs as the sun sets and sinks again by the time it rises.
    moonElevation: Math.sin(progress * Math.PI * 2 + Math.PI),
    moonAzimuth: progress * Math.PI * 2 + 0.55 + Math.PI,
  };
}

function smooth(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function mixNumber(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function mixColor(a: number, b: number, amount: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (Math.round(mixNumber(ar, br, amount)) << 16)
    | (Math.round(mixNumber(ag, bg, amount)) << 8)
    | Math.round(mixNumber(ab, bb, amount));
}
