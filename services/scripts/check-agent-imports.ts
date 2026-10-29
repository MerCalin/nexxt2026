/**
 * Architecture rule: agents never import each other, and never import adapters (AWS, simulated,
 * sanctions). They may depend only on contracts, ports, rules and ai-kit; everything else is injected.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set(["@dc/contracts", "@dc/ports", "@dc/rules", "@dc/ai-kit"]);
const root = join(import.meta.dir, "..", "packages", "agents");

export function findViolations(): string[] {
  const violations: string[] = [];
  for (const agent of readdirSync(root)) {
    const srcDir = join(root, agent, "src");
    let files: string[] = [];
    try {
      files = readdirSync(srcDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(root, agent, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (dep.startsWith("@dc/") && !ALLOWED.has(dep)) violations.push(`${agent}/package.json depends on ${dep}`);
    for (const f of files) {
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("@dc/") && !ALLOWED.has(spec)) violations.push(`${agent}/src/${f} imports ${spec}`);
        if (spec.startsWith("..")) violations.push(`${agent}/src/${f} uses a relative import outside its package: ${spec}`);
        if (/@aws-sdk\//.test(spec)) violations.push(`${agent}/src/${f} imports an AWS SDK directly: ${spec}`);
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const v = findViolations();
  if (v.length) {
    console.error(`Agent isolation violations:\n${v.join("\n")}`);
    process.exit(1);
  }
  console.log("agent isolation: ok");
}
