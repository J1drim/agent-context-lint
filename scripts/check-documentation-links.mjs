import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdown", ".markdown"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".pnpm-store",
  ".svn",
  "artifacts",
  "build",
  "dist",
  "coverage",
  "node_modules",
  "out",
  // The npm staging tree is generated from package sources and is not repository documentation.
  "publish",
  "target",
  "tmp",
  ".cache",
  ".yarn",
]);
const LINK_PATTERN =
  /!?\[[^\]\r\n]*\]\(\s*(?:<(?<bracketed>[^>\r\n]+)>|(?<plain>[^\s)]+))(?:\s+[^)]*)?\)/gu;
const HEADING_PATTERN = /^ {0,3}(?<marks>#{1,6})[ \t]+(?<text>.*?)[ \t]*#*[ \t]*$/gmu;
const DOCUMENTATION_PLACEHOLDERS = new Set(["N"]);

function fail(message) {
  throw new TypeError(message);
}

function isMarkdownFile(filePath) {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectFiles(rootDirectory, directory = rootDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      fail(
        `documentation tree contains a symbolic link: ${path.relative(rootDirectory, path.join(directory, entry.name))}`,
      );
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...(await collectFiles(rootDirectory, path.join(directory, entry.name))));
      }
      continue;
    }
    if (entry.isFile()) files.push(path.join(directory, entry.name));
  }
  return files.sort();
}

function withoutFencedCode(markdown) {
  const lines = markdown.split(/(\r?\n)/u);
  let fenced = false;
  let fence = "";
  return lines
    .map((line) => {
      if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? "";
        if (!fenced) {
          fenced = true;
          fence = marker[0];
        } else if (marker[0] === fence) {
          fenced = false;
        }
        return line.replace(/[^\r\n]/gu, " ");
      }
      return fenced ? line.replace(/[^\r\n]/gu, " ") : line;
    })
    .join("");
}

function githubSlug(text) {
  return text
    .replace(/<[^>]*>/gu, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s]+/gu, "-");
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const match of withoutFencedCode(markdown).matchAll(HEADING_PATTERN)) {
    const base = githubSlug(match.groups?.text ?? "");
    if (base.length === 0) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return anchors;
}

function destinationParts(destination) {
  const hash = destination.indexOf("#");
  if (hash < 0) return { file: destination, fragment: null };
  return { file: destination.slice(0, hash), fragment: destination.slice(hash + 1) };
}

function isExternal(destination) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination);
}

function normalizeDestination(destination) {
  return destination.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return null;
  }
}

export async function checkDocumentationLinks(rootDirectory) {
  if (typeof rootDirectory !== "string" || rootDirectory.length === 0)
    fail("rootDirectory is required");
  const root = path.resolve(rootDirectory);
  const files = await collectFiles(root);
  const filesByPath = new Set();
  const markdownByPath = new Map();
  const anchorsByPath = new Map();
  for (const filePath of files) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    filesByPath.add(relative);
    if (isMarkdownFile(filePath)) {
      const source = await readFile(filePath, "utf8");
      markdownByPath.set(relative, source);
      anchorsByPath.set(relative, headingAnchors(source));
    }
  }

  const errors = [];
  let checked = 0;
  for (const [relative, source] of markdownByPath) {
    const visible = withoutFencedCode(source);
    for (const match of visible.matchAll(LINK_PATTERN)) {
      const destination = match.groups?.bracketed ?? match.groups?.plain;
      if (destination === undefined || destination.length === 0 || isExternal(destination))
        continue;
      const { file, fragment } = destinationParts(destination);
      const target = normalizeDestination(file);
      const targetRelative =
        target.length === 0
          ? relative
          : path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
      if (!filesByPath.has(targetRelative) && !DOCUMENTATION_PLACEHOLDERS.has(target)) {
        const line = source.slice(0, match.index).split(/\r?\n/u).length;
        errors.push(
          `${relative}:${String(line)}: missing local documentation target ${destination}`,
        );
        continue;
      }
      checked += 1;
      const decodedFragment = fragment === null ? null : decodeFragment(fragment);
      if (
        fragment !== null &&
        fragment.length > 0 &&
        (decodedFragment === null || !anchorsByPath.get(targetRelative)?.has(decodedFragment))
      ) {
        const line = source.slice(0, match.index).split(/\r?\n/u).length;
        errors.push(`${relative}:${String(line)}: missing heading anchor ${destination}`);
      }
    }
  }
  if (errors.length > 0)
    fail(
      `documentation link check failed (${String(errors.length)} issue${errors.length === 1 ? "" : "s"})\n${errors.join("\n")}`,
    );
  return Object.freeze({ fileCount: markdownByPath.size, checkedLinkCount: checked });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDirectory = process.argv[2] ?? process.cwd();
  try {
    const result = await checkDocumentationLinks(rootDirectory);
    process.stdout.write(
      `Documentation links are valid (${String(result.fileCount)} Markdown files, ${String(result.checkedLinkCount)} local links).\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
