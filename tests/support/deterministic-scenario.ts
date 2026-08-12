import { AdvancingClock } from "../../packages/test-kit/src/clock.js";
import { createPathService } from "../../packages/test-kit/src/paths.js";
import { SEEDED_RANDOM_ALGORITHM, SeededRandom } from "../../packages/test-kit/src/random.js";
import { withTempWorkspace } from "../../packages/test-kit/src/workspace.js";

export async function renderDeterministicScenario(): Promise<string> {
  const random = new SeededRandom(20_260_801);
  const logicalFile = `samples/${String(random.nextInteger(10_000))}.txt`;
  const contents = [
    random.nextInteger(10_000),
    random.nextInteger(10_000),
    random.nextInteger(10_000),
  ].join(",");
  const clock = new AdvancingClock(1_893_456_000_000, 250);
  const posix = createPathService("posix");
  const windows = createPathService("win32");

  return withTempWorkspace({ [logicalFile]: contents }, async (workspace) => {
    const result = {
      algorithm: SEEDED_RANDOM_ALGORITHM,
      clock: [clock.now(), clock.now(), clock.now()],
      fixture: {
        contents: await workspace.readText(logicalFile),
        file: logicalFile,
      },
      paths: {
        posix: posix.resolveWithinRoot("/repo", "packages/api/AGENTS.md"),
        windows: windows.resolveWithinRoot("C:\\repo", "packages\\api\\AGENTS.md"),
      },
    };
    return `${JSON.stringify(result, null, 2)}\n`;
  });
}
