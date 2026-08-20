import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildLandmarkScenery } from "./landmark-scenery";
import { planLandmark } from "./landmarks";

describe("landmark scenery", () => {
  it.each(["bridge", "waterfall"] as const)("builds finite, bounded %s geometry", (kind) => {
    const plan = Array.from({ length: 8 }, (_, slot) => planLandmark(slot))
      .find((candidate) => candidate?.kind === kind);
    expect(plan?.kind).toBe(kind);
    if (!plan) return;

    const group = buildLandmarkScenery(plan, { quality: "high" });
    let meshCount = 0;
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount += 1;
      const positions = object.geometry.attributes.position;
      for (let index = 0; index < positions.count; index += 1) {
        expect(Number.isFinite(positions.getX(index))).toBe(true);
        expect(Number.isFinite(positions.getY(index))).toBe(true);
        expect(Number.isFinite(positions.getZ(index))).toBe(true);
      }
    });
    expect(meshCount).toBeGreaterThan(4);
    expect(meshCount).toBeLessThan(24);
  });
});
