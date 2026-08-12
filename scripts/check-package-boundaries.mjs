import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const WORKSPACE_PREFIX = "@agent-context/";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const RUNTIME_DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const PUBLIC_PACKAGES = new Set(["@agent-context/core", "@agent-context/lint"]);

export const BOUNDARY_POLICY = Object.freeze({
  "@agent-context/core": Object.freeze([]),
  "@agent-context/efficiency": Object.freeze([
    "@agent-context/core",
    "@agent-context/evidence",
    "@agent-context/resolver",
  ]),
  "@agent-context/evidence": Object.freeze(["@agent-context/core", "@agent-context/syntax"]),
  "@agent-context/formatters": Object.freeze([
    "@agent-context/core",
    "@agent-context/efficiency",
    "@agent-context/rules",
    "@agent-context/standards",
  ]),
  "@agent-context/lint": Object.freeze([
    "@agent-context/core",
    "@agent-context/efficiency",
    "@agent-context/evidence",
    "@agent-context/formatters",
    "@agent-context/profiles",
    "@agent-context/resolver",
    "@agent-context/rules",
    "@agent-context/standards",
    "@agent-context/syntax",
  ]),
  "@agent-context/markdown": Object.freeze(["@agent-context/core"]),
  "@agent-context/profiles": Object.freeze(["@agent-context/core", "@agent-context/syntax"]),
  "@agent-context/resolver": Object.freeze([
    "@agent-context/core",
    "@agent-context/evidence",
    "@agent-context/profiles",
    "@agent-context/syntax",
  ]),
  "@agent-context/rules": Object.freeze([
    "@agent-context/core",
    "@agent-context/efficiency",
    "@agent-context/evidence",
    "@agent-context/profiles",
    "@agent-context/resolver",
    "@agent-context/standards",
    "@agent-context/syntax",
  ]),
  "@agent-context/standards": Object.freeze(["@agent-context/core", "@agent-context/profiles"]),
  "@agent-context/syntax": Object.freeze(["@agent-context/core", "@agent-context/markdown"]),
  "@agent-context/test-kit": Object.freeze([]),
});

function formatViolation(packageName, message) {
  return `${packageName}: ${message}`;
}

export function validateDependencyEdge(fromPackage, toPackage, field = "dependencies") {
  if (!(fromPackage in BOUNDARY_POLICY)) {
    return formatViolation(fromPackage, "is not registered in the boundary policy");
  }
  if (!(toPackage in BOUNDARY_POLICY)) {
    return formatViolation(fromPackage, `depends on unknown workspace package ${toPackage}`);
  }
  if (
    toPackage === "@agent-context/test-kit" &&
    fromPackage !== toPackage &&
    field === "devDependencies"
  ) {
    return null;
  }
  if (!BOUNDARY_POLICY[fromPackage].includes(toPackage)) {
    return formatViolation(fromPackage, `${field} edge to ${toPackage} is forbidden`);
  }
  if (
    PUBLIC_PACKAGES.has(fromPackage) &&
    !PUBLIC_PACKAGES.has(toPackage) &&
    RUNTIME_DEPENDENCY_FIELDS.has(field)
  ) {
    return formatViolation(
      fromPackage,
      `public runtime edge to private package ${toPackage} is forbidden`,
    );
  }
  return null;
}

function internalDependencies(manifest) {
  const dependencies = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(WORKSPACE_PREFIX)) {
        dependencies.set(name, { field, specifier });
      }
    }
  }
  return dependencies;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listTypeScriptFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectModuleSpecifiers(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addStringLiteral(node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addStringLiteral(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStringLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function findWorkspacePackage(specifier, packageNames) {
  return packageNames.find(
    (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
  );
}

function findCycles(edges) {
  const cycles = [];
  const complete = new Set();
  const active = [];

  function visit(packageName) {
    if (active.includes(packageName)) {
      const cycleStart = active.indexOf(packageName);
      cycles.push([...active.slice(cycleStart), packageName].join(" -> "));
      return;
    }
    if (complete.has(packageName)) {
      return;
    }
    active.push(packageName);
    for (const target of edges.get(packageName) ?? []) {
      visit(target);
    }
    active.pop();
    complete.add(packageName);
  }

  for (const packageName of edges.keys()) {
    visit(packageName);
  }
  return [...new Set(cycles)];
}

export async function inspectWorkspace(rootDirectory) {
  const packagesDirectory = path.join(rootDirectory, "packages");
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const records = [];
  const violations = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const directory = path.join(packagesDirectory, entry.name);
    const manifest = await readJson(path.join(directory, "package.json"));
    const tsconfig = await readJson(path.join(directory, "tsconfig.json"));
    records.push({ directory, manifest, tsconfig });
  }

  const byName = new Map(records.map((record) => [record.manifest.name, record]));
  const byDirectory = new Map(records.map((record) => [path.resolve(record.directory), record]));
  const expectedNames = Object.keys(BOUNDARY_POLICY).sort();
  const actualNames = [...byName.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    violations.push(
      `workspace package set differs from policy: expected ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`,
    );
  }

  const packageNamesByLength = [...byName.keys()].sort((left, right) => right.length - left.length);
  const graph = new Map();

  for (const { directory, manifest, tsconfig } of records) {
    const packageName = manifest.name;
    const shouldBePrivate = !PUBLIC_PACKAGES.has(packageName);
    if ((manifest.private === true) !== shouldBePrivate) {
      violations.push(
        formatViolation(
          packageName,
          shouldBePrivate
            ? "must set private: true"
            : "is a logical public package and must not be private",
        ),
      );
    }
    if (manifest.type !== "module") {
      violations.push(formatViolation(packageName, 'must declare type: "module"'));
    }
    if (manifest.engines?.node !== "^24.11.0 || ^26.0.0") {
      violations.push(
        formatViolation(packageName, "does not match the accepted Node engine range"),
      );
    }

    const dependencies = internalDependencies(manifest);
    graph.set(packageName, new Set(dependencies.keys()));
    for (const [target, { field, specifier }] of dependencies) {
      if (!specifier.startsWith("workspace:")) {
        violations.push(formatViolation(packageName, `${field} ${target} must use workspace:`));
      }
      const edgeViolation = validateDependencyEdge(packageName, target, field);
      if (edgeViolation) {
        violations.push(edgeViolation);
      }
    }

    const references = new Set();
    for (const reference of tsconfig.references ?? []) {
      const targetDirectory = path.resolve(directory, reference.path);
      const targetRecord = byDirectory.get(targetDirectory);
      if (!targetRecord) {
        violations.push(
          formatViolation(packageName, `references unknown project ${reference.path}`),
        );
      } else {
        references.add(targetRecord.manifest.name);
      }
    }
    const dependencyNames = [...dependencies.keys()].sort();
    const referenceNames = [...references].sort();
    if (JSON.stringify(dependencyNames) !== JSON.stringify(referenceNames)) {
      violations.push(
        formatViolation(
          packageName,
          `project references (${referenceNames.join(", ")}) must equal workspace dependencies (${dependencyNames.join(", ")})`,
        ),
      );
    }

    for (const filePath of await listTypeScriptFiles(directory)) {
      const sourceText = await readFile(filePath, "utf8");
      for (const specifier of collectModuleSpecifiers(filePath, sourceText)) {
        if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
          const resolved = path.resolve(path.dirname(filePath), specifier);
          if (!isPathInside(directory, resolved)) {
            violations.push(
              formatViolation(
                packageName,
                `${path.relative(rootDirectory, filePath)} imports outside its package: ${specifier}`,
              ),
            );
          }
          continue;
        }
        const target = findWorkspacePackage(specifier, packageNamesByLength);
        if (target && target !== packageName && !dependencies.has(target)) {
          violations.push(
            formatViolation(
              packageName,
              `${path.relative(rootDirectory, filePath)} imports undeclared workspace package ${target}`,
            ),
          );
        }
      }
    }
  }

  for (const cycle of findCycles(graph)) {
    violations.push(`workspace dependency cycle: ${cycle}`);
  }

  return violations.sort();
}

async function main() {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await inspectWorkspace(rootDirectory);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`boundary violation: ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Package boundaries valid for ${Object.keys(BOUNDARY_POLICY).length} packages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
