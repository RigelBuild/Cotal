/**
 * The package-shape probe runs in cold-setup.yml before native lifecycle qualification.
 * installer.yml separately covers install.sh onboarding on supported environments.
 * This file reads the live workflows and checks structural invariants.
 *
 * Run: pnpm smoke:install-probe-ci
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/install-probe-ci.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COLD_SETUP = join(ROOT, ".github", "workflows", "cold-setup.yml");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
}

function jobs(text: string): Map<string, string> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = new Map<string, string>();
  if (start < 0) return out;
  let current: string | undefined;
  const buf: string[] = [];
  const flush = (): void => {
    if (current) out.set(current, buf.join("\n"));
    buf.length = 0;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== "") break;
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    if (current) buf.push(l);
  }
  flush();
  return out;
}
// This fork does not publish to npm and releases through rigel-release.yml.
const coldJobs = jobs(readFileSync(COLD_SETUP, "utf8"));
const probeBody = coldJobs.get("candidate") ?? "";
check(
  "cold setup owns the pre-publication package-shape probe",
  probeBody.indexOf("post-publish-install-probe.mjs") >= 0 &&
    probeBody.indexOf("post-publish-install-probe.mjs") < probeBody.indexOf("pack-cold-candidate.mjs"),
);

const lifecycleNeeds = (coldJobs.get("lifecycle") ?? "").match(/^\s+needs:\s*(\S+)/m)?.[1];
check("native qualification depends on the probed candidate", lifecycleNeeds === "candidate", { lifecycleNeeds });
const installerJobs = jobs(readFileSync(join(ROOT, ".github", "workflows", "installer.yml"), "utf8"));
check(
  "installer workflow retains shell lint, onboarding matrix, and macOS install lanes",
  /shellcheck/.test(installerJobs.get("lint") ?? "") &&
    /install\/test-matrix\.sh/.test(installerJobs.get("matrix") ?? "") &&
    /sh install\.sh --no-setup/.test(installerJobs.get("macos") ?? ""),
);

// The cold candidate must run the probe script.
check(
  "cold candidate runs the post-publish-install-probe script",
  /post-publish-install-probe\.mjs/.test(probeBody),
  probeBody.slice(0, 200),
);

// The candidate build must finish before package-shape probing.
check(
  "cold candidate builds before the probe",
  probeBody.indexOf("pnpm build") >= 0 &&
    probeBody.indexOf("pnpm build") < probeBody.indexOf("post-publish-install-probe"),
  "build must come before probe",
);


const EXPECTED = 5;
check(`every cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED, pass + fail);
console.log(`\nINSTALL PROBE CI SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
console.log("SUITE COMPLETE");
if (fail) process.exitCode = 1;
