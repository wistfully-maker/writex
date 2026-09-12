import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "SKILL.md",
  "manifest.txt",
  "references/enhancement/architecture.md",
  "references/enhancement/router.md",
  "references/enhancement/ledger-model.md",
  "references/enhancement/ensemble-character-life.md",
  "references/enhancement/research-provenance.md",
  "references/orchestrator/project-lifecycle.md",
  "references/orchestrator/publishing-package.md",
  "references/orchestrator/visual-handoff.md",
  "rules/integrated-policy.yaml",
  "rules/risk-taxonomy.yaml",
  "rules/ensemble-character-life-engine.yaml",
  "rules/project-orchestrator.yaml",
  "patterns/pattern-library.yaml",
  "profiles/scene-language-modes.yaml",
  "workflows/start-novel.md",
  "workflows/launch-novel-project.md",
  "workflows/plan-longform.md",
  "workflows/write-chapter.md",
  "workflows/character-life-audit.md",
  "workflows/audit-and-replan.md",
  "workflows/build-project-package.md",
  "templates/novel-project-canon.yaml",
  "templates/character-life-contract.yaml",
  "templates/publishing-package.yaml",
  "templates/visual-brief.yaml",
  "adapters/external-visual-skill.md",
  "evals/conflict-audit.md",
  "evals/gate-classification.md",
  "evals/limited-after-integration-eval.md",
  "evals/ensemble-orchestrator-eval.md",
];

for (const rel of required) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) throw new Error(`missing required file: ${rel}`);
  if (fs.statSync(p).size === 0) throw new Error(`empty required file: ${rel}`);
}

const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
for (const token of [
  "version: 0.3.0",
  "Novel Project Orchestrator",
  "Ensemble Character Life",
  "Progressive loading",
  "Originality boundary",
  "HUMAN_ARCHITECTURE_APPROVED",
]) {
  if (!skill.includes(token)) throw new Error(`SKILL.md missing: ${token}`);
}

const publicFiles = [
  "SKILL.md",
  "rules/integrated-policy.yaml",
  "patterns/pattern-library.yaml",
  "workflows/write-chapter.md",
].map(x => fs.readFileSync(path.join(root, x), "utf8"));

const affirmativeImitationPatterns = [
  /(?:^|\n)\s*(?:do|must|should)\s+write\s+exactly\s+like/im,
  /(?:^|\n)\s*(?:imitate|mimic|copy)\s+(?:jiang nan|dragon raja(?:'s)? prose)/im,
  /named_author_imitation:\s*(?:allowed|required|true)/im,
];

for (const text of publicFiles) {
  for (const pattern of affirmativeImitationPatterns) {
    if (pattern.test(text)) throw new Error(`affirmative imitation instruction detected: ${pattern}`);
  }
}

console.log("WriteX Youth-Mythic v0.3.0 validation: PASS");
console.log(`required files: ${required.length}`);
console.log("layers: Base + 7A-7G + Stage8");
