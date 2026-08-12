/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/test-kit" as const;

export { AdvancingClock, FixedClock } from "./clock.js";
export { createPathService, DeterministicPathService, type TestPathFlavor } from "./paths.js";
export { createSeededRandom, SEEDED_RANDOM_ALGORITHM, SeededRandom } from "./random.js";
export {
  createTempWorkspace,
  type FixtureFileContents,
  type FixtureFiles,
  TempWorkspace,
  withTempWorkspace,
} from "./workspace.js";
