import { describe, expect, it } from "vitest";
import { formatDistance } from "./ui";

describe("formatDistance", () => {
  it("shows short rides as whole meters", () => {
    expect(formatDistance(0)).toEqual({ value: "0", unit: "m" });
    expect(formatDistance(999.9)).toEqual({ value: "999", unit: "m" });
  });

  it("switches to kilometers at one thousand meters", () => {
    expect(formatDistance(1000)).toEqual({ value: "1.00", unit: "km" });
    expect(formatDistance(12_345)).toEqual({ value: "12.35", unit: "km" });
  });
});
