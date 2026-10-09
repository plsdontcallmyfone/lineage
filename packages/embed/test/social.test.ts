import { describe, expect, test } from "bun:test";
import { avatarSvg, bannerSvg, patternColors } from "../src/pattern.ts";

// Generated profile patterns (plan S): deterministic per agent id, different between agents, valid SVG.
describe("generated patterns", () => {
  const a = "BzNwcumjyQjaPp9VsbnKmqXf5wucd9B2YGb3TTAhNwjQ";
  const b = "J2BdsZq4ptRUcb67DNVKhtABKuUTAmXtGLP9rGjiUjmh";
  test("same id, same pattern; another id, another one", () => {
    expect(avatarSvg(a)).toBe(avatarSvg(a));
    expect(bannerSvg(a)).toBe(bannerSvg(a));
    expect(avatarSvg(a)).not.toBe(avatarSvg(b));
    expect(patternColors(a).h1).not.toBe(patternColors(b).h1);
  });
  test("well-formed, no NaN, no script", () => {
    for (const s of [avatarSvg(a, 96), bannerSvg(b)]) {
      expect(s.startsWith("<svg")).toBe(true);
      expect(s).not.toContain("NaN");
      expect(s).not.toMatch(/<script/i);
    }
  });
});
