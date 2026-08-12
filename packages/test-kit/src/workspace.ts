import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPathService } from "./paths.js";

export type FixtureFileContents = string | Uint8Array;
export type FixtureFiles = Readonly<Record<string, FixtureFileContents>>;

const hostPaths = createPathService("posix");

function normalizeLogicalPath(relativePath: string): string {
  if (relativePath.includes("\\")) {
    throw new TypeError("fixture paths must use forward slashes on every host platform");
  }
  const resolved = hostPaths.resolveWithinRoot("/__fixture__", relativePath);
  return hostPaths.relative("/__fixture__", resolved);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** Hermetic temporary fixture directory with explicit lifecycle and root-contained file helpers. */
export class TempWorkspace {
  readonly root: string;
  #active = true;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new TypeError("temporary workspace root must be absolute");
    }
    this.root = root;
  }

  resolvePath(relativePath: string): string {
    this.#requireActive();
    const normalized = normalizeLogicalPath(relativePath);
    return path.join(this.root, ...normalized.split("/"));
  }

  async write(relativePath: string, contents: FixtureFileContents): Promise<void> {
    const destination = this.resolvePath(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.resolvePath(relativePath), "utf8");
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.resolvePath(relativePath));
      return true;
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    await rm(this.root, { force: true, recursive: true });
  }

  #requireActive(): void {
    if (!this.#active) {
      throw new Error("temporary workspace has already been cleaned up");
    }
  }
}

export async function createTempWorkspace(files: FixtureFiles = {}): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-lint-fixture-"));
  const workspace = new TempWorkspace(root);
  try {
    for (const relativePath of Object.keys(files).sort()) {
      const contents = files[relativePath];
      if (contents === undefined) {
        throw new TypeError(`fixture file ${relativePath} has undefined contents`);
      }
      await workspace.write(relativePath, contents);
    }
    return workspace;
  } catch (error: unknown) {
    await workspace.cleanup();
    throw error;
  }
}

export async function withTempWorkspace<Result>(
  files: FixtureFiles,
  run: (workspace: TempWorkspace) => Promise<Result>,
): Promise<Result> {
  const workspace = await createTempWorkspace(files);
  try {
    return await run(workspace);
  } finally {
    await workspace.cleanup();
  }
}
