export type RenderQuality = "low" | "high";

export interface Settings {
  quality: RenderQuality;
  reduceMotion: boolean;
  sound: boolean;
  volume: number;
}

const SETTINGS_KEY = "slowbicycle:settings";
const PROGRESS_KEY = "slowbicycle:progress";

const DEFAULT_SETTINGS: Settings = {
  quality: "high",
  reduceMotion: false,
  sound: true,
  volume: 0.7,
};

export function loadSettings(): Settings {
  const stored = readJson<Partial<Settings>>(SETTINGS_KEY, {});
  return {
    quality: stored.quality === "low" ? "low" : "high",
    reduceMotion: stored.reduceMotion === true,
    sound: stored.sound !== false,
    volume: clampNumber(stored.volume, 0, 1, DEFAULT_SETTINGS.volume),
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadBestDistance(): number {
  const stored = readJson<{ bestDistanceMeters?: number }>(PROGRESS_KEY, {});
  return clampNumber(stored.bestDistanceMeters, 0, Number.MAX_SAFE_INTEGER, 0);
}

export function saveBestDistance(bestDistanceMeters: number): void {
  writeJson(PROGRESS_KEY, { bestDistanceMeters: Math.max(0, bestDistanceMeters) });
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The simulation remains playable when storage is unavailable or full.
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
