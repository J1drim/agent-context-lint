import path from "node:path";

const TIMING_KEYS = new Set(["duration", "endTime", "startTime"]);

function replaceWorkspace(value, workspaceRoot) {
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedValue.replaceAll(normalizedRoot, "<workspace>");
}

function normalizeValue(value, workspaceRoot) {
  if (typeof value === "string") {
    return replaceWorkspace(value, workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, workspaceRoot));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!TIMING_KEYS.has(key)) {
      result[key] = normalizeValue(value[key], workspaceRoot);
    }
  }
  return result;
}

function compareProperty(property) {
  return (left, right) => {
    const leftValue = String(left[property]);
    const rightValue = String(right[property]);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  };
}

/** Removes timing and machine paths, then sorts Vitest results into canonical semantic order. */
export function normalizeVitestReport(report, workspaceRoot) {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new TypeError("workspaceRoot must be absolute");
  }
  const normalized = normalizeValue(report, workspaceRoot);
  if (Array.isArray(normalized.testResults)) {
    normalized.testResults.sort(compareProperty("name"));
    for (const testResult of normalized.testResults) {
      if (Array.isArray(testResult.assertionResults)) {
        testResult.assertionResults.sort(compareProperty("fullName"));
      }
    }
  }
  return normalized;
}

export function serializeVitestReport(report, workspaceRoot) {
  return `${JSON.stringify(normalizeVitestReport(report, workspaceRoot), null, 2)}\n`;
}
