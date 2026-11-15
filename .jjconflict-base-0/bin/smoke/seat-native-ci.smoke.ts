/**
 * The ARM load job consumes one packed tarball. Native linux-x64 and linux-arm64
 * builder jobs must stay wired into the PR pack path and the cold candidate used
 * by normal and snapshot publication. A deleted dependency or artifact download
 * silently ships one arch, and the assembler/runtime smokes cannot see that edit.
 *
 * This file reads the workflow text. It does not run GitHub's engine. Indentation
 * is the reader, because `bin/` has no YAML dependency. A job or step shape this
 * reader cannot resolve is a FAILURE, not a skip.
 *
 * Run: pnpm smoke:seat-native-ci
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/seat-native-ci.json
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const CHANGESETS = join(ROOT, ".github", "workflows", "changesets.yml.disabled");

const BUILDERS = ["seat-native-linux-x64", "seat-native-linux-arm64"] as const;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
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

function needsList(body: string): string[] {
  const inline = body.match(/^\s+needs:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => /^\s+needs:\s*$/.test(l));
  if (idx < 0) return [];
  const found: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s+-\s+(\S+)\s*$/);
    if (!item) break;
    found.push(item[1]);
  }
  return found;
}

function downloaded(body: string): string[] {
  const names: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/download-artifact@/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^\s+-\s+uses:/.test(lines[j]) || /^\s+-\s+name:/.test(lines[j])) break;
      const n = lines[j].match(/^\s+(?:name|pattern):\s*(\S+)\s*$/);
      if (n) {
        names.push(n[1]);
        break;
      }
    }
  }
  return names;
}

function hasBoth(got: string[], label: string, extra?: unknown): void {
  check(
    label,
    BUILDERS.every((name) => got.includes(name)),
    extra ?? { got },
  );
}

/** The `path:` of each upload-artifact step, in order. */
function uploaded(body: string): string[] {
  const paths: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^\s+-\s+(uses|name|run):/.test(lines[j])) break;
      const p = lines[j].match(/^\s+path:\s*(\S+)\s*$/);
      if (p) {
        paths.push(p[1]);
        break;
      }
    }
  }
  return paths;
}

/** A builder ships pty.node beside peercred.node only by uploading its whole linux-<arch>/ dir. */
function shipsBothNatives(file: string, all: Map<string, string>): void {
  for (const builder of BUILDERS) {
    const body = all.get(builder) ?? "";
    const arch = builder.replace("seat-native-linux-", "");
    const paths = uploaded(body);
    check(
      `${file} ${builder} uploads the whole linux-${arch}/ directory (peercred.node and pty.node)`,
      paths.length === 1 && paths[0] === `packages/seat/build/Release/linux-${arch}/`,
      { paths },
    );
    const build = body.indexOf("pnpm --filter @cotal-ai/seat build");
    const ceiling = body.indexOf("node packages/seat/scripts/assert-native-ceiling.mjs");
    const upload = body.indexOf("actions/upload-artifact@");
    check(
      `${file} ${builder} enforces the native symbol-version ceiling before upload`,
      build >= 0 && ceiling > build && upload > ceiling,
      { build, ceiling, upload },
    );
  }
}

const ciText = readFileSync(CI, "utf8");
const csText = readFileSync(CHANGESETS, "utf8");
const ciJobs = jobs(ciText);
const csJobs = jobs(csText);
const pack = ciJobs.get("seat-pack") ?? "";
const version = csJobs.get("version") ?? "";
const snapshot = csJobs.get("snapshot") ?? "";

console.log("A. PR pack path in ci.yml");
check("ci.yml declares job seat-pack", pack.length > 0);
hasBoth(needsList(pack), "ci.yml seat-pack needs both native linux builders");
hasBoth(downloaded(pack), "ci.yml seat-pack downloads both native linux artifacts");
check(
  "ci.yml seat-pack runs the shared seat pack assembler",
  /scripts\/ci-seat-pack\.sh/.test(pack),
  pack.slice(0, 200),
);

console.log("\nB. Native candidate before qualification");
const coldText = readFileSync(join(ROOT, ".github", "workflows", "cold-setup.yml"), "utf8");
const coldJobs = jobs(coldText);
const native = coldJobs.get("native") ?? "";
const candidate = coldJobs.get("candidate") ?? "";
const packer = readFileSync(join(ROOT, "scripts/pack-cold-candidate.mjs"), "utf8");
check("cold candidate needs the native builder matrix", needsList(candidate).includes("native"));
check("cold native matrix builds x64 and arm64 on native Linux", /arch: x64\s+runner: ubuntu-latest/.test(native) && /arch: arm64\s+runner: ubuntu-24.04-arm/.test(native));
check("cold candidate downloads both native artifacts", ["cold-native-x64", "cold-native-arm64"].every((name) => downloaded(candidate).includes(name)));
check("cold candidate assembles natives before packing", candidate.indexOf("seat-assemble-natives.mjs") >= 0 && candidate.indexOf("seat-assemble-natives.mjs") < candidate.indexOf("pack-cold-candidate.mjs"));
check("cold candidate runs prepublish guards before packing", packer.includes('"run", "prepublishOnly"') && packer.indexOf('"run", "prepublishOnly"') < packer.indexOf('"pack", "--pack-destination"'));
const windowsNative = coldJobs.get("workspace-native") ?? "";
const windowsRecipe = readFileSync(join(ROOT, ".github/workflows/workspace-native.yml"), "utf8");
check("cold candidate needs the Windows native builder", needsList(candidate).includes("workspace-native"));
check("cold Windows builder uses the shared dual-architecture recipe", /^\s+uses:\s*\.\/.github\/workflows\/workspace-native\.yml\s*$/m.test(windowsNative) && !/architectures:/.test(windowsNative) && /default:\s*'\["x64",\s*"arm64"\]'/.test(windowsRecipe));
check("cold candidate downloads both Windows native artifacts", ["workspace-native-x64", "workspace-native-arm64"].every((name) => downloaded(candidate).includes(name)));
check("cold candidate assembles Windows natives before packing", candidate.indexOf("workspace-assemble-natives.mjs") >= 0 && candidate.indexOf("workspace-assemble-natives.mjs") < candidate.indexOf("pack-cold-candidate.mjs"));
// The workspace prepack also requires both macOS bindings, so every caller that packs asks the shared
// recipe for them and hands both to the assembler.
check("the shared recipe builds the macOS bindings natively on Intel and Apple silicon", /darwin:\s+if: inputs\.darwin/.test(windowsRecipe) && /"x64":"macos-15-intel","arm64":"macos-15"/.test(windowsRecipe) && /name: workspace-native-darwin-\$\{\{ matrix\.arch \}\}/.test(windowsRecipe));
check("cold candidate requests, downloads and assembles both macOS native artifacts", /^\s+darwin: true\s*$/m.test(windowsNative)
  && ["workspace-native-darwin-x64", "workspace-native-darwin-arm64"].every((name) => downloaded(candidate).includes(name))
  && ["WORKSPACE_NATIVE_DARWIN_X64", "WORKSPACE_NATIVE_DARWIN_ARM64"].every((name) => candidate.includes(name)));

console.log("\nC. Disabled Changesets version and snapshot paths");
check("changesets.yml declares job version", version.length > 0);
hasBoth(needsList(version), "changesets.yml version needs both native linux builders");
hasBoth(downloaded(version), "changesets.yml version downloads both native linux artifacts");
check("changesets.yml version job is bound to the npm-publish Environment", /^\s+environment:\s*npm-publish\s*$/m.test(version));
check("changesets.yml declares job snapshot", snapshot.length > 0);
hasBoth(needsList(snapshot), "changesets.yml snapshot needs both native linux builders");
hasBoth(downloaded(snapshot), "changesets.yml snapshot downloads both native linux artifacts");
check("changesets.yml snapshot runs the shared assembler", /scripts\/seat-assemble-natives\.mjs/.test(snapshot));
check("Changesets snapshot job reaches the release preflight before its recursive publish", snapshot.indexOf("preflight-npm-publish.mjs") >= 0 && snapshot.indexOf("preflight-npm-publish.mjs") < snapshot.indexOf("pnpm publish -r"));
check("changesets.yml snapshot job is bound to the npm-publish Environment", /^\s+environment:\s*npm-publish\s*$/m.test(snapshot));

console.log("\nD. Desktop host artifacts");
const hostTargets = ["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
check("PR pack needs the shared host builder", needsList(pack).includes("workspace-native"));
check("PR pack requests the macOS host builds", /^\s+darwin: true\s*$/m.test(ciJobs.get("workspace-native") ?? ""));
for (const [name, body] of [["PR", pack], ["cold", candidate]]) {
  check(`${name} pack downloads all four desktop host artifacts`, hostTargets.every((target) => downloaded(body).some((spec) => spec === `seat-native-${target}` || (spec.endsWith("*") && `seat-native-${target}`.startsWith(spec.slice(0, -1))))));
}
for (const [name, body] of [["PR", pack], ["cold", candidate]]) {
  check(`${name} pack supplies all four host artifacts to assembly`, hostTargets.every((target) => body.includes(`SEAT_NATIVE_${target.toUpperCase().replaceAll("-", "_")}`)));
}
check("shared host builders compile and upload seat helpers", (windowsRecipe.match(/node packages\/seat\/scripts\/build-native.mjs --host/g) ?? []).length === 2
  && windowsRecipe.includes("name: seat-native-win32-${{ matrix.arch }}") && windowsRecipe.includes("name: seat-native-darwin-${{ matrix.arch }}"));

// Container-header fixtures test the packaging validator, not native loading or execution.
console.log("\nE. Native container validation fixtures");
const fixture = mkdtempSync(join(tmpdir(), "cotal-native-headers-"));
const headers = new Map<string, Buffer>();
for (const [arch, machine] of [["x64", 62], ["arm64", 183]] as const) {
  const bytes = Buffer.alloc(64); bytes.write("\x7fELF", 0, "ascii"); bytes.writeUInt16LE(machine, 18);
  headers.set(`linux-${arch}`, bytes);
}
for (const [arch, machine] of [["x64", 0x01000007], ["arm64", 0x0100000c]] as const) {
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(machine, 4); bytes.writeUInt32LE(8, 12);
  headers.set(`darwin-${arch}`, bytes);
}
for (const [arch, machine] of [["x64", 0x8664], ["arm64", 0xaa64]] as const) {
  const bytes = Buffer.alloc(128); bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.write("PE\0\0", 64); bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(0x2000, 86);
  headers.set(`win32-${arch}`, bytes);
}
const targetPath = (target: string) => join(fixture, "build", "Release", target, "peercred.node");
const validate = () => spawnSync(process.execPath, [join(ROOT, "packages/seat/scripts/assert-shipped-natives.mjs"), fixture], { encoding: "utf8", timeout: 10_000 });
try {
  for (const [target, bytes] of headers) { mkdirSync(dirname(targetPath(target)), { recursive: true }); writeFileSync(targetPath(target), bytes); }
  for (const arch of ["x64", "arm64"]) writeFileSync(join(dirname(targetPath(`linux-${arch}`)), "pty.node"), headers.get(`linux-${arch}`)!);
  check("all six matching container headers pass", validate().status === 0);
  for (const target of hostTargets) {
    rmSync(targetPath(target));
    check(`missing ${target} refuses packaging`, validate().status !== 0);
    writeFileSync(targetPath(target), headers.get(target)!);
    const wrong = Buffer.from(headers.get(target)!);
    if (target.startsWith("darwin")) wrong.writeUInt32LE(0, 4); else wrong.writeUInt16LE(0, 68);
    writeFileSync(targetPath(target), wrong);
    check(`wrong ${target} architecture refuses packaging`, validate().status !== 0);
    writeFileSync(targetPath(target), headers.get(target)!);
  }
  const exe = Buffer.from(headers.get("win32-x64")!); exe.writeUInt16LE(0, 86);
  writeFileSync(targetPath("win32-x64"), exe);
  check("a PE executable cannot substitute for the addon DLL", validate().status !== 0);
  writeFileSync(targetPath("win32-x64"), headers.get("win32-x64")!);
  const macho = Buffer.from(headers.get("darwin-x64")!); macho.writeUInt32LE(2, 12);
  writeFileSync(targetPath("darwin-x64"), macho);
  check("a Mach-O executable cannot substitute for the addon bundle", validate().status !== 0);
  writeFileSync(targetPath("darwin-x64"), headers.get("darwin-x64")!);
  writeFileSync(targetPath("win32-arm64"), Buffer.alloc(0));
  check("a truncated host artifact refuses packaging", validate().status !== 0);
} finally { rmSync(fixture, { recursive: true, force: true }); }

console.log("\nD. Native builders ship pty.node, and ARM loads it");
shipsBothNatives("ci.yml", ciJobs);
shipsBothNatives("changesets.yml", csJobs);
const nativeEnv = [...`${ciText}\n${csText}`.matchAll(/SEAT_NATIVE_(?:X64|ARM64):[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1]);
check(
  "SEAT_NATIVE_X64 and SEAT_NATIVE_ARM64 name the builder directory, not one file",
  nativeEnv.length === 8 && nativeEnv.every((v) => /\/seat-native-linux-(x64|arm64)$/.test(v)),
  nativeEnv,
);
check(
  "ci.yml seat-linux-arm64 runs the pinned PTY load probe against the installed tarball",
  /node src\/packages\/seat\/smoke\/fixtures\/pinned-load\.mjs "\$\{RUNNER_TEMP\}\/seat-prefix\/node_modules\/@cotal-ai\/seat"/.test(
    ciJobs.get("seat-linux-arm64") ?? "",
  ),
);

console.log(`\n${fail === 0 ? "SEAT NATIVE CI SMOKE OK" : "SEAT NATIVE CI SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
