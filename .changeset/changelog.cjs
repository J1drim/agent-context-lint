"use strict";

const allowedKinds = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);

function formatSummary(summary) {
  const normalized = summary.trim().replace(/\s+/gu, " ");
  const separator = normalized.indexOf(":");
  const kind = separator === -1 ? "" : normalized.slice(0, separator);
  if (!allowedKinds.has(kind) || normalized.slice(separator + 1).trim() === "") {
    throw new Error(
      "Changeset summaries must use `Added|Changed|Deprecated|Removed|Fixed|Security: summary`.",
    );
  }
  return `- ${normalized}`;
}

async function getReleaseLine(changeset) {
  return formatSummary(changeset.summary);
}

async function getDependencyReleaseLine(changesets, dependenciesUpdated) {
  if (changesets.length > 0)
    return changesets.map((entry) => formatSummary(entry.summary)).join("\n");
  const names = dependenciesUpdated.map((entry) => `\`${entry.name}\``).join(", ");
  return `- Changed: update internal dependencies (${names}).`;
}

module.exports = { getDependencyReleaseLine, getReleaseLine };
