import { beforeEach, describe, expect, it } from "vitest";
import { loadBestDistance, loadSettings, saveBestDistance, saveSettings } from "./storage";

const values = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});

describe("local persistence", () => {
  beforeEach(() => values.clear());

  it("round-trips validated settings", () => {
    saveSettings({ quality: "low", reduceMotion: true, sound: false, volume: 0.35 });
    expect(loadSettings()).toEqual({ quality: "low", reduceMotion: true, sound: false, volume: 0.35 });
  });

  it("recovers from invalid values", () => {
    values.set("slowbicycle:settings", JSON.stringify({ quality: "ultra", volume: 8 }));
    expect(loadSettings()).toEqual({ quality: "high", reduceMotion: false, sound: true, volume: 1 });

    values.set("slowbicycle:progress", "not-json");
    expect(loadBestDistance()).toBe(0);
  });

  it("never persists a negative distance", () => {
    saveBestDistance(-200);
    expect(loadBestDistance()).toBe(0);
  });
});
