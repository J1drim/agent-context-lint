import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const standardsProposalWorkflowPath = path.join(
  root,
  "tools",
  "standards",
  "standards-update-proposal.mjs",
);

/**
 * Compatibility-named export retained for recovery tooling. Standards proposals are generated
 * locally and remain drafts; this validator ensures the tool cannot become a hosted publisher.
 */
export function validateStandardsProposalWorkflowSource(source) {
  const issues = [];
  if (typeof source !== "string" || !source.includes("prepareStandardsUpdateProposal"))
    issues.push("local standards proposal tool is missing its deterministic generator");
  if (typeof source === "string" && !source.includes('status: "draft-human-review-required"'))
    issues.push("local standards proposals must remain draft human-review artifacts");
  if (
    typeof source === "string" &&
    /actions\/runs|pull_request_target|secrets\.|git push|gh pr|npm publish|pnpm publish/u.test(
      source,
    )
  )
    issues.push("local standards proposal tool must not use hosted runs or external mutation");
  return issues;
}

export async function validateCommittedStandardsProposalWorkflow() {
  const issues = validateStandardsProposalWorkflowSource(
    await readFile(standardsProposalWorkflowPath, "utf8"),
  );
  if (issues.length > 0)
    throw new Error(`Local standards proposal controls violated:\n- ${issues.join("\n- ")}`);
  return Object.freeze({ hostedWorkflow: false, publication: "human-review" });
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    await validateCommittedStandardsProposalWorkflow();
    process.stdout.write("Local standards proposal controls validated.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "local validation failed"}\n`);
    process.exitCode = 1;
  }
}
