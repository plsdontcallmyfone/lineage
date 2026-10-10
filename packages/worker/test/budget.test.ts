import { expect, test } from "bun:test";
import { wrapUpNotice } from "../src/proposers/budget.ts";

test("the wrap-up notice fires near the attempt cap, or when one more turn could cross it", () => {
  expect(wrapUpNotice(0.1, 0.5, 0.05)).toBeNull();
  expect(wrapUpNotice(0.36, 0.5, 0.02)).toContain("submit it now");
  expect(wrapUpNotice(0.2, 0.5, 0.16)).toContain("give_up"); // 0.2 + 2 * 0.16 > 0.5
  expect(wrapUpNotice(0.1, 0, 0.1)).toBeNull();
});
