function normalizeWorkspacePath(filePath, workspaceRoot) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedPath === normalizedRoot) {
    return "<workspace>";
  }
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw new RangeError(`coverage path is outside the workspace: ${filePath}`);
  }
  return `<workspace>/${normalizedPath.slice(normalizedRoot.length + 1)}`;
}

function sortRecursively(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortRecursively(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = sortRecursively(value[key]);
  }
  return result;
}

function normalizeHitCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("coverage hit count must be a non-negative safe integer");
  }
  return value === 0 ? 0 : 1;
}

function normalizeHitCounts(record) {
  for (const field of ["s", "f"]) {
    const counts = record[field];
    if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
      throw new TypeError(`coverage ${field} counts must be an object`);
    }
    for (const key of Object.keys(counts)) counts[key] = normalizeHitCount(counts[key]);
  }
  const branches = record.b;
  if (branches === null || typeof branches !== "object" || Array.isArray(branches)) {
    throw new TypeError("coverage b counts must be an object");
  }
  for (const key of Object.keys(branches)) {
    if (!Array.isArray(branches[key])) throw new TypeError("coverage branch counts must be arrays");
    branches[key] = branches[key].map(normalizeHitCount);
  }
}

/** Converts Istanbul coverage JSON to stable, root-independent bytes. */
export function normalizeCoverageMap(coverageMap, workspaceRoot) {
  const result = {};
  for (const sourcePath of Object.keys(coverageMap).sort()) {
    const normalizedPath = normalizeWorkspacePath(sourcePath, workspaceRoot);
    const record = sortRecursively(coverageMap[sourcePath]);
    normalizeHitCounts(record);
    record.path = normalizedPath;
    result[normalizedPath] = record;
  }
  return result;
}

export function serializeCoverageMap(coverageMap, workspaceRoot) {
  return `${JSON.stringify(normalizeCoverageMap(coverageMap, workspaceRoot), null, 2)}\n`;
}
