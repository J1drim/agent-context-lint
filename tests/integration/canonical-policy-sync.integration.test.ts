import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type SourceDocument,
  type SourceDocumentId,
} from "../../packages/core/dist/index.js";
import {
  selectRepositoryRoot,
  type SafeFixSourceSnapshot,
} from "../../packages/evidence/src/index.js";
import {
  CANONICAL_POLICY_TARGET_IDS,
  createCanonicalPolicySynchronizer,
} from "../../packages/resolver/src/index.js";
import { withTempWorkspace } from "../../packages/test-kit/src/index.js";
import { expect, test } from "vitest";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(path: string, text: string): SourceDocument {
  const digest = sha256(text);
  return {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: `source:${digest}` as SourceDocumentId,
    lineEnding: "lf",
    parseState: { state: "complete" },
    path: canonicalizeRepositoryRelativePath(path),
    rootNodeId: `ast:${digest}` as SourceDocument["rootNodeId"],
    sha256: digest,
    text,
    utf16Length: text.length,
  };
}

test("I13 public composition emits the versioned all-profile root golden without repository writes", async () => {
  await withTempWorkspace({}, async (workspace) => {
    const root = workspace.resolvePath("repo");
    const target = workspace.resolvePath("repo/AGENTS.md");
    const text = "# Policy\n\n- Run the complete test suite.\n";
    await mkdir(root, { recursive: true });
    await writeFile(target, text);
    const stats = await lstat(target, { bigint: true });
    const canonical: SafeFixSourceSnapshot = {
      identity: { device: String(stats.dev), inode: String(stats.ino) },
      source: source("AGENTS.md", text),
    };
    const selection = await selectRepositoryRoot(root, { mode: "explicit" });
    const preview = await (
      await createCanonicalPolicySynchronizer(selection)
    ).preview({
      canonical,
      policyId: "root-policy",
      targets: CANONICAL_POLICY_TARGET_IDS.map((targetId) => ({
        current: null,
        priorBase: null,
        targetId,
      })),
    });

    expect(
      preview.targets.map((targetPreview) => ({
        application: targetPreview.application,
        formatId: targetPreview.formatId,
        path: targetPreview.path,
        profiles: targetPreview.profiles.map((profile) => ({
          profileId: profile.profileId,
          specSnapshotId: profile.specSnapshotId,
          surfaceId: profile.surfaceId,
          uncertainty: profile.uncertainty,
        })),
        semanticEquivalenceClaimed: targetPreview.semanticEquivalenceClaimed,
        state: targetPreview.state,
        targetId: targetPreview.targetId,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "application": "preview-only",
          "formatId": "claude-memory-markdown",
          "path": "CLAUDE.md",
          "profiles": [
            {
              "profileId": "claude-code",
              "specSnapshotId": "claude-code/2026-08-01",
              "surfaceId": "claude-code/local-session",
              "uncertainty": "known",
            },
          ],
          "semanticEquivalenceClaimed": false,
          "state": "preview-only",
          "targetId": "claude-code",
        },
        {
          "application": "preview-only",
          "formatId": "copilot-repository-markdown",
          "path": ".github/copilot-instructions.md",
          "profiles": [
            {
              "profileId": "copilot-cli",
              "specSnapshotId": "copilot-surfaces/2026-08-01.0",
              "surfaceId": "copilot-cli/local-terminal",
              "uncertainty": "known",
            },
            {
              "profileId": "copilot-vscode",
              "specSnapshotId": "copilot-surfaces/2026-08-01.0",
              "surfaceId": "copilot-vscode/local-chat",
              "uncertainty": "known",
            },
          ],
          "semanticEquivalenceClaimed": false,
          "state": "preview-only",
          "targetId": "copilot",
        },
        {
          "application": "preview-only",
          "formatId": "cursor-mdc",
          "path": ".cursor/rules/canonical-root-policy.mdc",
          "profiles": [
            {
              "profileId": "cursor-agent",
              "specSnapshotId": "cursor/2026-08-01",
              "surfaceId": "cursor-agent/cli",
              "uncertainty": "known",
            },
            {
              "profileId": "cursor-agent",
              "specSnapshotId": "cursor/2026-08-01",
              "surfaceId": "cursor-agent/ide",
              "uncertainty": "known",
            },
          ],
          "semanticEquivalenceClaimed": false,
          "state": "preview-only",
          "targetId": "cursor-agent",
        },
        {
          "application": "preview-only",
          "formatId": "gemini-context-markdown",
          "path": "GEMINI.md",
          "profiles": [
            {
              "profileId": "gemini-cli",
              "specSnapshotId": "gemini-cli/2026-08-02.0",
              "surfaceId": "gemini-cli/local-terminal",
              "uncertainty": "known",
            },
          ],
          "semanticEquivalenceClaimed": false,
          "state": "preview-only",
          "targetId": "gemini-cli",
        },
      ]
    `);
    expect(await lstat(target)).toMatchObject({ size: Buffer.byteLength(text, "utf8") });
  });
});
