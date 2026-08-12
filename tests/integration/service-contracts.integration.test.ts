import { expect, test } from "vitest";

import type { Clock, PathService, RandomSource } from "../../packages/core/src/services.js";
import { FixedClock } from "../../packages/test-kit/src/clock.js";
import { createPathService } from "../../packages/test-kit/src/paths.js";
import { SeededRandom } from "../../packages/test-kit/src/random.js";

test("test-kit services structurally satisfy the dependency-free core contracts", () => {
  const clock: Clock = new FixedClock(1_000);
  const random: RandomSource = new SeededRandom(42);
  const paths: PathService = createPathService("posix");

  expect(clock.now()).toBe(1_000);
  expect(random.nextFloat()).toBeGreaterThanOrEqual(0);
  expect(paths.resolveWithinRoot("/repo", "src/index.ts")).toBe("/repo/src/index.ts");
});
