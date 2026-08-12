import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
  type SourceDocument,
  type SourceDocumentId,
} from "@agent-context/core";
import {
  SafeFixError,
  createReadOnlyRepository,
  selectRepositoryRoot,
  type RepositoryRootSelection,
  type SafeFixSourceSnapshot,
} from "@agent-context/evidence";
import { parseCursorRuleSyntax } from "@agent-context/syntax";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  CANONICAL_POLICY_PREVIEW_RECORD_KIND,
  CANONICAL_POLICY_SYNC_CONTRACT_VERSION,
  CANONICAL_POLICY_TARGET_IDS,
  CanonicalPolicySyncError,
  CanonicalPolicySyncErrorCode,
  createCanonicalPolicySynchronizer,
  resolveCursorProfile,
  type CanonicalPolicyBase,
  type CanonicalPolicyPreviewRequest,
  type CanonicalPolicyTargetId,
  type CanonicalPolicyTargetInput,
} from "../src/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineEnding(text: string): SourceDocument["lineEnding"] {
  const values = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") {
        values.add("crlf");
        index += 1;
      } else values.add("cr");
    } else if (text[index] === "\n") values.add("lf");
  }
  return values.size === 0
    ? "none"
    : values.size > 1
      ? "mixed"
      : (values.values().next().value as SourceDocument["lineEnding"]);
}

function sourceDocument(pathValue: string, text: string): SourceDocument {
  const digest = sha256(text);
  const stable = sha256(`${pathValue}\0${digest}`);
  return Object.freeze({
    bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: `source:${stable}` as SourceDocumentId,
    lineEnding: lineEnding(text),
    parseState: Object.freeze({ state: "complete" }),
    path: canonicalizeRepositoryRelativePath(pathValue),
    rootNodeId: `ast:${stable}` as SourceDocument["rootNodeId"],
    sha256: digest,
    text,
    utf16Length: text.length,
  });
}

async function snapshot(
  selection: RepositoryRootSelection,
  pathValue: string,
  text?: string,
): Promise<SafeFixSourceSnapshot> {
  const repository = await createReadOnlyRepository(selection);
  const file = await repository.readFile(canonicalizeRepositoryRelativePath(pathValue));
  return Object.freeze({
    identity: file.identity,
    source: sourceDocument(pathValue, text ?? Buffer.from(file.bytes()).toString("utf8")),
  });
}

async function forgedSnapshot(
  target: string,
  pathValue: string,
  text: string,
): Promise<SafeFixSourceSnapshot> {
  const stats = await lstat(target, { bigint: true });
  return Object.freeze({
    identity: Object.freeze({ device: String(stats.dev), inode: String(stats.ino) }),
    source: sourceDocument(pathValue, text),
  });
}

function targets(
  values: Partial<
    Record<CanonicalPolicyTargetId, Omit<CanonicalPolicyTargetInput, "targetId">>
  > = {},
): readonly CanonicalPolicyTargetInput[] {
  return CANONICAL_POLICY_TARGET_IDS.map((targetId) =>
    Object.freeze({
      current: values[targetId]?.current ?? null,
      priorBase: values[targetId]?.priorBase ?? null,
      targetId,
    }),
  );
}

async function fixture(
  resolvePath: (value: string) => string,
  canonicalText = "# Repository policy\n\n- Run tests before merging.\n",
  canonicalPath = "AGENTS.md",
): Promise<{
  readonly canonical: SafeFixSourceSnapshot;
  readonly root: string;
  readonly selection: RepositoryRootSelection;
}> {
  const root = resolvePath("repo");
  await mkdir(path.dirname(resolvePath(`repo/${canonicalPath}`)), { recursive: true });
  await writeFile(resolvePath(`repo/${canonicalPath}`), canonicalText);
  const selection = await selectRepositoryRoot(root, { mode: "explicit" });
  return { canonical: await snapshot(selection, canonicalPath), root, selection };
}

function request(
  canonical: SafeFixSourceSnapshot,
  targetValues: readonly CanonicalPolicyTargetInput[] = targets(),
): CanonicalPolicyPreviewRequest {
  return { canonical, policyId: "repository-policy", targets: targetValues };
}

describe("I13 canonical-policy synchronization", () => {
  test("generates deterministic immutable parser/resolver-verified previews for every root vendor target without writing", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((value) => workspace.resolvePath(value));
      const before = await readdir(state.root);
      const firstSynchronizer = await createCanonicalPolicySynchronizer(state.selection);
      const first = await firstSynchronizer.preview(request(state.canonical));
      const second = await (
        await createCanonicalPolicySynchronizer(state.selection)
      ).preview(request(state.canonical));

      expect(first.recordKind).toBe(CANONICAL_POLICY_PREVIEW_RECORD_KIND);
      expect(first.contractVersion).toBe(CANONICAL_POLICY_SYNC_CONTRACT_VERSION);
      expect(first.targets.map((item) => [item.targetId, item.state, item.application])).toEqual([
        ["claude-code", "preview-only", "preview-only"],
        ["copilot", "preview-only", "preview-only"],
        ["cursor-agent", "preview-only", "preview-only"],
        ["gemini-cli", "preview-only", "preview-only"],
      ]);
      expect(first.targets.every((item) => item.nextBase !== null)).toBe(true);
      expect(
        first.targets
          .flatMap((item) => item.profiles)
          .every(
            (profile) =>
              profile.profileId.length > 0 &&
              profile.surfaceId.length > 0 &&
              profile.specSnapshotId.length > 0 &&
              profile.evidenceRefs.length > 0,
          ),
      ).toBe(true);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(sha256(first.patch)).toBe(first.patchSha256);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.targets)).toBe(true);
      expect(await readdir(state.root)).toEqual(before);

      await expect(firstSynchronizer.apply(first.targets[0])).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.unsupportedApply,
      });
      expect(await readdir(state.root)).toEqual(before);
    });
  });

  test("scopes nested Cursor output and refuses Copilot's unresolved cross-surface glob semantics", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture(
        (value) => workspace.resolvePath(value),
        "# API policy\n\n- Validate API input.\n",
        "packages/api/AGENTS.md",
      );
      const preview = await (
        await createCanonicalPolicySynchronizer(state.selection)
      ).preview(request(state.canonical));

      const copilot = preview.targets.find((item) => item.targetId === "copilot");
      expect(copilot).toMatchObject({
        afterSha256: null,
        application: "not-applicable",
        mergeState: "unrepresentable",
        nextBase: null,
        state: "refused",
      });
      const cursor = preview.targets.find((item) => item.targetId === "cursor-agent");
      if (cursor === undefined) throw new Error("missing Cursor preview");
      expect(cursor).toMatchObject({
        afterSha256: null,
        application: "not-applicable",
        mergeState: "unrepresentable",
        nextBase: null,
        path: "packages/api/.cursor/rules/canonical-repository-policy.mdc",
        state: "refused",
      });
      expect(cursor.profiles.every((profile) => profile.uncertainty === "unknown")).toBe(true);
      expect(cursor.reason).toContain("did not activate");

      const exactScopedContent = '---\nalwaysApply: false\nglobs:\n  - "**"\n---\n# API policy\n';
      const bytes = Uint8Array.from(Buffer.from(exactScopedContent, "utf8"));
      const parsed = parseCursorRuleSyntax({
        bytes,
        documentId: "document:test",
        format: "mdc",
        path: cursor.path,
        sourceId: "source:test",
      });
      expect(parsed.modeSyntax.classification).toBe("auto-attached");

      const candidate = {
        bytes,
        format: "mdc" as const,
        path: cursor.path,
      };
      const resolve = (targetPath: string): ReturnType<typeof resolveCursorProfile> =>
        resolveCursorProfile({
          candidates: [candidate],
          runtime: {
            clientVersion: "3.12.30",
            eventState: "present",
            events: [
              {
                kind: "reference-path",
                sequence: 1,
                targetPath: canonicalizeRepositoryRelativePath(targetPath),
              },
            ],
            externalContext: "absent",
            projectRules: "enabled",
            surfaceId: "cursor-agent/ide",
            workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
          },
        });
      expect(resolve("packages/api/src/index.ts").candidates[0]?.activation).toBe("indeterminate");
      expect(resolve("packages/web/src/index.ts").candidates[0]?.activation).toBe("inactive");
    });
  });

  test("refuses profile-specific imports, Markdown links, comments, and frontmatter-like canonical input", async () => {
    for (const text of [
      "# Policy\n\n@docs/policy.md\n",
      "# Policy\n\nRead [policy](docs/policy.md).\n",
      "# Policy\n\n<!-- hidden -->\n- Test.\n",
      "---\npaths: ['src/**']\n---\n# Policy\n",
    ]) {
      await withTempWorkspace({}, async (workspace) => {
        const state = await fixture((value) => workspace.resolvePath(value), text);
        const preview = await (
          await createCanonicalPolicySynchronizer(state.selection)
        ).preview(request(state.canonical));
        expect(preview.targets.every((item) => item.state === "refused")).toBe(true);
        expect(preview.targets.every((item) => item.mergeState === "unrepresentable")).toBe(true);
        expect(preview.targets.every((item) => item.nextBase === null)).toBe(true);
      });
    }
  });

  test("uses the conservative base/current/generated matrix and atomically applies only a clean existing-file update", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const initial = await fixture((value) => workspace.resolvePath(value));
      const first = await (
        await createCanonicalPolicySynchronizer(initial.selection)
      ).preview(request(initial.canonical));
      const claudeBase = first.targets[0]?.nextBase;
      if (claudeBase === null || claudeBase === undefined) throw new Error("missing Claude base");
      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), claudeBase.content);
      await writeFile(
        workspace.resolvePath("repo/AGENTS.md"),
        "# Repository policy\n\n- Run tests and lint before merging.\n",
      );
      const canonical = await snapshot(initial.selection, "AGENTS.md");
      const current = await snapshot(initial.selection, "CLAUDE.md");
      const synchronizer = await createCanonicalPolicySynchronizer(initial.selection);
      const update = await synchronizer.preview(
        request(canonical, targets({ "claude-code": { current, priorBase: claudeBase } })),
      );
      expect(update.targets[0]).toMatchObject({
        application: "existing-file-atomic",
        mergeState: "clean-update",
        state: "ready",
      });
      const result = await synchronizer.apply(update.targets[0]);
      expect(result.appliedPaths).toEqual(["CLAUDE.md"]);
      expect(await readFile(workspace.resolvePath("repo/CLAUDE.md"), "utf8")).toBe(
        update.targets[0]?.nextBase?.content,
      );
      await expect(synchronizer.apply(update.targets[0])).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.invalidPreview,
      });
    });
  });

  test("refuses hand edits, malformed bases, deleted generated files, malformed current files, and untracked generated files", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const initial = await fixture((value) => workspace.resolvePath(value));
      const first = await (
        await createCanonicalPolicySynchronizer(initial.selection)
      ).preview(request(initial.canonical));
      const base = first.targets[0]?.nextBase;
      if (base === null || base === undefined) throw new Error("missing base");
      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), `${base.content}\nHand edit.\n`);
      await writeFile(workspace.resolvePath("repo/AGENTS.md"), "# Changed\n\n- New policy.\n");
      const canonical = await snapshot(initial.selection, "AGENTS.md");
      const edited = await snapshot(initial.selection, "CLAUDE.md");
      const synchronizer = await createCanonicalPolicySynchronizer(initial.selection);

      const handEdit = await synchronizer.preview(
        request(canonical, targets({ "claude-code": { current: edited, priorBase: base } })),
      );
      expect(handEdit.targets[0]).toMatchObject({
        application: "not-applicable",
        mergeState: "hand-edit-conflict",
        state: "refused",
      });
      expect(await readFile(workspace.resolvePath("repo/CLAUDE.md"), "utf8")).toContain(
        "Hand edit.",
      );

      const malformedBase = { ...base, generatedSha256: "0".repeat(64) } as CanonicalPolicyBase;
      const malformed = await synchronizer.preview(
        request(
          canonical,
          targets({ "claude-code": { current: edited, priorBase: malformedBase } }),
        ),
      );
      expect(malformed.targets[0]?.mergeState).toBe("malformed-prior-base");

      const missing = await synchronizer.preview(
        request(canonical, targets({ "claude-code": { current: null, priorBase: base } })),
      );
      expect(missing.targets[0]?.mergeState).toBe("missing-current");

      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), "ordinary hand-authored prose\n");
      const ordinary = await snapshot(initial.selection, "CLAUDE.md");
      const malformedCurrent = await synchronizer.preview(
        request(canonical, targets({ "claude-code": { current: ordinary, priorBase: null } })),
      );
      expect(malformedCurrent.targets[0]?.mergeState).toBe("malformed-current");

      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), base.content);
      const oldGenerated = await snapshot(initial.selection, "CLAUDE.md");
      const untracked = await synchronizer.preview(
        request(canonical, targets({ "claude-code": { current: oldGenerated, priorBase: null } })),
      );
      expect(untracked.targets[0]?.mergeState).toBe("untracked-existing");
    });
  });

  test("I11/I10 CAS refuses a concurrent edit without overwriting it", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const initial = await fixture((value) => workspace.resolvePath(value));
      const first = await (
        await createCanonicalPolicySynchronizer(initial.selection)
      ).preview(request(initial.canonical));
      const base = first.targets[0]?.nextBase;
      if (base === null || base === undefined) throw new Error("missing base");
      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), base.content);
      await writeFile(workspace.resolvePath("repo/AGENTS.md"), "# Changed\n\n- New policy.\n");
      const synchronizer = await createCanonicalPolicySynchronizer(initial.selection);
      const update = await synchronizer.preview(
        request(
          await snapshot(initial.selection, "AGENTS.md"),
          targets({
            "claude-code": {
              current: await snapshot(initial.selection, "CLAUDE.md"),
              priorBase: base,
            },
          }),
        ),
      );
      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), "concurrent owner edit\n");
      await expect(synchronizer.apply(update.targets[0])).rejects.toBeInstanceOf(SafeFixError);
      expect(await readFile(workspace.resolvePath("repo/CLAUDE.md"), "utf8")).toBe(
        "concurrent owner edit\n",
      );
    });
  });

  test("I11/I10 rejects symlink, hard-link, and non-file replacements", async () => {
    if (process.platform === "win32") return;
    for (const kind of ["symlink", "hardlink", "directory"] as const) {
      await withTempWorkspace({}, async (workspace) => {
        const initial = await fixture((value) => workspace.resolvePath(value));
        const first = await (
          await createCanonicalPolicySynchronizer(initial.selection)
        ).preview(request(initial.canonical));
        const base = first.targets[0]?.nextBase;
        if (base === null || base === undefined) throw new Error("missing base");
        const target = workspace.resolvePath("repo/CLAUDE.md");
        if (kind === "symlink") {
          await writeFile(workspace.resolvePath("repo/owned.md"), base.content);
          await symlink("owned.md", target);
        } else if (kind === "hardlink") {
          await writeFile(workspace.resolvePath("repo/owned.md"), base.content);
          await link(workspace.resolvePath("repo/owned.md"), target);
        } else await mkdir(target);
        await writeFile(workspace.resolvePath("repo/AGENTS.md"), "# Changed\n\n- New policy.\n");
        const synchronizer = await createCanonicalPolicySynchronizer(initial.selection);
        const update = await synchronizer.preview(
          request(
            await snapshot(initial.selection, "AGENTS.md"),
            targets({
              "claude-code": {
                current: await forgedSnapshot(target, "CLAUDE.md", base.content),
                priorBase: base,
              },
            }),
          ),
        );
        expect(update.targets[0]?.state).toBe("ready");
        await expect(synchronizer.apply(update.targets[0])).rejects.toBeInstanceOf(SafeFixError);
        if (kind === "directory") expect((await lstat(target)).isDirectory()).toBe(true);
        else
          expect((await lstat(target)).isSymbolicLink() || (await lstat(target)).nlink > 1).toBe(
            true,
          );
      });
    }
  });

  test("rejects hostile containers, unsafe identifiers, malformed canonical state, cancellation, and deadline exhaustion", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((value) => workspace.resolvePath(value));
      const synchronizer = await createCanonicalPolicySynchronizer(state.selection);
      await expect(
        synchronizer.preview(new Proxy(request(state.canonical), {})),
      ).rejects.toBeInstanceOf(CanonicalPolicySyncError);
      await expect(
        synchronizer.preview({ ...request(state.canonical), policyId: "../escape" }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });
      const completeTargets = targets();
      const firstTarget = completeTargets[0];
      const thirdTarget = completeTargets[2];
      const fourthTarget = completeTargets[3];
      if (firstTarget === undefined || thirdTarget === undefined || fourthTarget === undefined)
        throw new Error("target fixture is incomplete");
      const sparse: CanonicalPolicyTargetInput[] = [];
      sparse.length = 4;
      sparse[0] = firstTarget;
      sparse[2] = thirdTarget;
      sparse[3] = fourthTarget;
      await expect(
        synchronizer.preview({ ...request(state.canonical), targets: sparse }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });
      await expect(
        synchronizer.preview({
          ...request(state.canonical),
          canonical: {
            ...state.canonical,
            source: {
              ...state.canonical.source,
              parseState: { state: "malformed", reason: "bad" },
            },
          },
        }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.unsafeSource });

      const controller = new AbortController();
      controller.abort();
      await expect(
        createCanonicalPolicySynchronizer(state.selection, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.aborted });

      const large = await fixture(
        (value) => workspace.resolvePath(`large/${value}`),
        `# Large\n\n${"- deterministic instruction\n".repeat(1_000)}`,
      );
      const bounded = await createCanonicalPolicySynchronizer(large.selection, {
        maximumDurationMs: 1,
      });
      await expect(bounded.preview(request(large.canonical))).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.deadline,
      });
    });
  });

  test("rejects closed-contract violations and forged source metadata at every trust boundary", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((value) => workspace.resolvePath(value));
      const invalidOptions: readonly unknown[] = [
        new Date(),
        { maximumCanonicalBytes: 0 },
        { maximumDurationMs: Number.NaN },
        { signal: {} },
      ];
      for (const options of invalidOptions) {
        await expect(
          createCanonicalPolicySynchronizer(
            state.selection,
            options as Parameters<typeof createCanonicalPolicySynchronizer>[1],
          ),
        ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });
      }

      const synchronizer = await createCanonicalPolicySynchronizer(state.selection);
      const baseRequest = request(state.canonical);
      const invalidRequests: readonly unknown[] = [
        {},
        { ...baseRequest, extra: true },
        { ...baseRequest, targets: null },
        { ...baseRequest, targets: [...targets(), targets()[0]] },
        { ...baseRequest, targets: targets().slice(0, 3) },
        {
          ...baseRequest,
          targets: [targets()[1], targets()[0], targets()[2], targets()[3]],
        },
      ];
      for (const invalid of invalidRequests) {
        await expect(synchronizer.preview(invalid)).rejects.toBeInstanceOf(
          CanonicalPolicySyncError,
        );
      }

      const sourceMutations: readonly Partial<SourceDocument>[] = [
        { text: 42 as never },
        { byteLength: state.canonical.source.byteLength + 1 },
        { encoding: "utf-16" as SourceDocument["encoding"] },
        { id: "bad id" as SourceDocumentId },
        { path: "../escape" as RepositoryRelativePath },
        { bom: "utf-8" },
        { lineEnding: "crlf" },
        { parseState: { state: "unknown" } as never },
        { parseState: { reason: "unexpected", state: "complete" } as never },
        { sha256: "0".repeat(64) },
      ];
      for (const sourceMutation of sourceMutations) {
        await expect(
          synchronizer.preview({
            ...baseRequest,
            canonical: {
              ...state.canonical,
              source: { ...state.canonical.source, ...sourceMutation },
            },
          }),
        ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });
      }
      await expect(
        synchronizer.preview({
          ...baseRequest,
          canonical: {
            ...state.canonical,
            identity: { ...state.canonical.identity, device: "-1" },
          },
        }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });

      const accessorRequest = { ...baseRequest };
      Object.defineProperty(accessorRequest, "canonical", {
        enumerable: true,
        get: () => state.canonical,
      });
      await expect(synchronizer.preview(accessorRequest)).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.invalidInput,
      });
      const accessorTargets = [...targets()];
      Object.defineProperty(accessorTargets, "0", {
        enumerable: true,
        get: () => targets()[0],
      });
      await expect(
        synchronizer.preview({ ...baseRequest, targets: accessorTargets }),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });

      const liveController = new AbortController();
      const cancelled = await createCanonicalPolicySynchronizer(state.selection, {
        signal: liveController.signal,
      });
      liveController.abort();
      await expect(cancelled.preview(baseRequest)).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.aborted,
      });
      await expect(synchronizer.apply(null)).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.invalidPreview,
      });
      await expect(synchronizer.apply({})).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.invalidPreview,
      });
    });
  });

  test("enforces byte bounds, exact target paths, idempotence, and hostile prior-base refusal", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((value) => workspace.resolvePath(value));
      const tinyCanonical = await createCanonicalPolicySynchronizer(state.selection, {
        maximumCanonicalBytes: 1,
      });
      await expect(tinyCanonical.preview(request(state.canonical))).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.resourceLimit,
      });
      const tinyTarget = await createCanonicalPolicySynchronizer(state.selection, {
        maximumTargetBytes: 1,
      });
      await expect(tinyTarget.preview(request(state.canonical))).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.resourceLimit,
      });

      const firstSynchronizer = await createCanonicalPolicySynchronizer(state.selection);
      const first = await firstSynchronizer.preview(request(state.canonical));
      const largestPatch = Math.max(
        ...first.targets.map((target) => Buffer.byteLength(target.patch, "utf8")),
      );
      const aggregateBounded = await createCanonicalPolicySynchronizer(state.selection, {
        maximumPatchBytes: largestPatch,
      });
      await expect(aggregateBounded.preview(request(state.canonical))).rejects.toMatchObject({
        code: CanonicalPolicySyncErrorCode.resourceLimit,
      });
      const base = first.targets[0]?.nextBase;
      if (base === null || base === undefined) throw new Error("missing Claude base");
      await writeFile(workspace.resolvePath("repo/CLAUDE.md"), base.content);
      const current = await snapshot(state.selection, "CLAUDE.md");
      const idempotent = await firstSynchronizer.preview(
        request(state.canonical, targets({ "claude-code": { current, priorBase: base } })),
      );
      expect(idempotent.targets[0]).toMatchObject({
        application: "not-applicable",
        mergeState: "already-current",
        state: "unchanged",
      });
      expect(idempotent.targets[0]?.patch).toBe("");

      const wrongPath = {
        ...current,
        source: { ...current.source, path: canonicalizeRepositoryRelativePath("other.md") },
      };
      await expect(
        firstSynchronizer.preview(
          request(
            state.canonical,
            targets({ "claude-code": { current: wrongPath, priorBase: base } }),
          ),
        ),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.invalidInput });

      await writeFile(workspace.resolvePath("repo/AGENTS.md"), "# Changed\n\n- New policy.\n");
      const changedCanonical = await snapshot(state.selection, "AGENTS.md");
      const hostileBase = new Proxy(base, {});
      const refused = await firstSynchronizer.preview(
        request(changedCanonical, targets({ "claude-code": { current, priorBase: hostileBase } })),
      );
      expect(refused.targets[0]?.mergeState).toBe("malformed-prior-base");

      for (const malformedHeader of [
        base.content.replace(
          "<!-- agent-context-lint-canonical-policy:{",
          "<!-- agent-context-lint-canonical-policy:{broken",
        ),
        base.content.replace(base.canonicalSha256, "z".repeat(64)),
        base.content.replace('"formatId":"claude-memory-markdown"', '"formatId":42'),
      ]) {
        await writeFile(workspace.resolvePath("repo/CLAUDE.md"), malformedHeader);
        const malformedCurrent = await snapshot(state.selection, "CLAUDE.md");
        const malformedPreview = await firstSynchronizer.preview(
          request(
            changedCanonical,
            targets({ "claude-code": { current: malformedCurrent, priorBase: null } }),
          ),
        );
        expect(malformedPreview.targets[0]?.mergeState).toBe("malformed-current");
      }
    });
  });

  test("preserves CRLF and CR snapshots and refuses canonical input beyond Codex's proven limit", async () => {
    for (const text of ["# Policy\r\n\r\n- Check.\r\n", "# Policy\r\r- Check.\r"]) {
      await withTempWorkspace({}, async (workspace) => {
        const state = await fixture((value) => workspace.resolvePath(value), text);
        const preview = await (
          await createCanonicalPolicySynchronizer(state.selection)
        ).preview(request(state.canonical));
        expect(preview.targets[0]?.nextBase?.content).toContain(text);
      });
    }
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture(
        (value) => workspace.resolvePath(value),
        `# Oversized for Codex\n\n${"- bounded policy text\n".repeat(2_000)}`,
      );
      await expect(
        (await createCanonicalPolicySynchronizer(state.selection)).preview(
          request(state.canonical),
        ),
      ).rejects.toMatchObject({ code: CanonicalPolicySyncErrorCode.unsafeSource });
    });
  });

  test("keeps bounded plain-policy generation deterministic across generated cases", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("property/repo");
      await mkdir(root, { recursive: true });
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      for (let index = 0; index < 40; index += 1) {
        const text = `# Policy ${String(index)}\n\n- Require check ${String((index * 7919) % 104729)}.\n`;
        await writeFile(path.join(root, "AGENTS.md"), text);
        const canonical = await snapshot(selection, "AGENTS.md");
        const left = await (
          await createCanonicalPolicySynchronizer(selection)
        ).preview(request(canonical));
        const right = await (
          await createCanonicalPolicySynchronizer(selection)
        ).preview(request(canonical));
        expect(JSON.stringify(left)).toBe(JSON.stringify(right));
        expect(left.targets.every((item) => item.nextBase?.content.includes(text) === true)).toBe(
          true,
        );
      }
    });
  });

  test("validates serializable previews against the closed published v1 schema", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((value) => workspace.resolvePath(value));
      const preview = await (
        await createCanonicalPolicySynchronizer(state.selection)
      ).preview(request(state.canonical));
      const schema = JSON.parse(
        await readFile(
          new URL("../schemas/canonical-policy-preview.v1.schema.json", import.meta.url),
          "utf8",
        ),
      ) as object;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      const validate = ajv.compile(schema);
      expect(
        validate(JSON.parse(JSON.stringify(preview))),
        validate.errors?.map(String).join("\n"),
      ).toBe(true);
      const invalid = JSON.parse(JSON.stringify(preview)) as Record<string, unknown>;
      const invalidTargets = invalid["targets"] as Record<string, unknown>[];
      const firstInvalidTarget = invalidTargets[0];
      if (firstInvalidTarget === undefined) throw new Error("schema fixture has no targets");
      firstInvalidTarget["semanticEquivalenceClaimed"] = true;
      expect(validate(invalid)).toBe(false);
    });
  });
});
