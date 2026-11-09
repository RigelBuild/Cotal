#!/usr/bin/env node
/**
 *
 * Customer `npm i` does not run this. A publishable tree is assembled in CI
 * from native builder artifacts. This script never cross-compiles and never
 * skips an arch: it only builds the host.
 *
 * Linux and macOS compile native/peercred.c with the host `cc` against the
 * Node headers that ship next to this Node binary. Windows compiles
 * native/peercred_win32.c with `cl.exe` from the MSVC Developer Command Prompt
 * against the Node headers and import library the workspace binding pins,
 * downloaded and checksummed, because a Windows addon links node.lib.
 *
 * `pnpm build` runs this without `--host` and compiles on Linux only, so a
 * macOS or Windows workspace build needs no C toolchain. `build:native` passes
 * `--host` and compiles for whichever of the three platforms runs it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const releaseRoot = join(root, "build", "Release");
mkdirSync(releaseRoot, { recursive: true });

const platform = process.platform;
const host = process.argv.includes("--host");
if (platform !== "linux" && !(host && (platform === "darwin" || platform === "win32"))) {
  process.exit(0);
}
const arch = process.arch;

function fail(lines, status = 1) {
  for (const line of lines) console.error(line);
  process.exit(status);
}

const stale = join(releaseRoot, "peercred.node");
if (existsSync(stale)) rmSync(stale);
const outDir = join(releaseRoot, `${platform}-${arch}`);

if (platform === "win32") buildWindows();
else buildPosix();

function buildPosix() {
  const src = join(root, "native", "peercred.c");
  const include = join(dirname(process.execPath), "..", "include", "node");
  if (!existsSync(join(include, "node_api.h"))) {
    fail([
      `@cotal-ai/seat: node_api.h not found at ${include} (from ${process.execPath}). A source build needs the Node headers that ship next to that binary.`,
    ]);
  }
  const check = platform === "linux" ? linuxTarget() : darwinTarget();
  console.error(
    platform === "linux"
      ? `@cotal-ai/seat: host dev build for linux-${arch}. This is not a publishable tree. Pack and publish require both linux-x64 (ELF e_machine 62) and linux-arm64 (ELF e_machine 183), assembled from native builder jobs.`
      : `@cotal-ai/seat: host dev build for darwin-${arch}. This is not a publishable tree.`,
  );
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "peercred.node");
  const args =
    platform === "linux"
      ? ["-shared", "-fPIC", "-D_GNU_SOURCE", "-o", out, src, `-I${include}`]
      : ["-bundle", "-undefined", "dynamic_lookup", "-mmacosx-version-min=11.0", "-o", out, src, `-I${include}`, "-framework", "CoreFoundation"];
  const result = spawnSync("cc", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    const detail = result.error
      ? result.error.message
      : `${result.stderr || result.stdout || `cc exited ${result.status ?? 1}`}`;
    fail(
      [
        `@cotal-ai/seat: failed to compile the ${check.what} helper for ${platform}-${arch}.`,
        `command: cc ${args.join(" ")}`,
        detail.trim() || "(no compiler diagnostic)",
        "A C compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helpers and do not compile on install.",
      ],
      result.status ?? 1,
    );
  }
  check.verify(out);
}

function linuxTarget() {
  /** ELF e_machine: EM_X86_64=62, EM_AARCH64=183. */
  const ELF_MACHINE = { x64: 62, arm64: 183 };
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-${arch} (supported: linux-x64, linux-arm64)`]);
  }
  return {
    what: "SO_PEERCRED",
    verify(out) {
      let machine;
      try {
        const buf = readFileSync(out);
        if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") {
          throw new Error(`${out} is not an ELF file`);
        }
        machine = buf.readUInt16LE(18);
      } catch (err) {
        fail([`@cotal-ai/seat: ${err instanceof Error ? err.message : String(err)}`]);
      }
      if (machine !== expected) fail([`@cotal-ai/seat: linux-${arch} helper at ${out} has ELF e_machine ${machine}, expected ${expected}.`]);
    },
  };
}

function darwinTarget() {
  /** Mach-O cputype: CPU_TYPE_X86_64, CPU_TYPE_ARM64. */
  const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
  const expected = MACHO_CPU[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: LOCAL_PEERCRED native helper unsupported on darwin-${arch} (supported: darwin-x64, darwin-arm64)`]);
  }
  return {
    what: "LOCAL_PEERCRED",
    verify(out) {
      const buf = readFileSync(out);
      if (buf.length < 8 || buf.readUInt32LE(0) !== 0xfeedfacf) fail([`@cotal-ai/seat: ${out} is not a 64-bit Mach-O file`]);
      const cpu = buf.readUInt32LE(4);
      if (cpu !== expected) fail([`@cotal-ai/seat: darwin-${arch} helper at ${out} has Mach-O cputype 0x${cpu.toString(16)}, expected 0x${expected.toString(16)}.`]);
    },
  };
}

function buildWindows() {
  /** PE machine: IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64. */
  const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };
  const expected = PE_MACHINE[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: named-pipe native helper unsupported on win32-${arch} (supported: win32-x64, win32-arm64)`]);
  }
  // The compiler comes from the MSVC Developer Command Prompt, as the workspace binding's does: no
  // Visual Studio discovery runs here, which is what node-gyp could not do on a newer Studio.
  if (!process.env.VCToolsVersion) fail(["@cotal-ai/seat: build the Windows helper in the matching MSVC Developer Command Prompt (VCToolsVersion is unset)"]);
  console.error(`@cotal-ai/seat: host dev build for win32-${arch}. This is not a publishable tree.`);
  const work = mkdtempSync(join(tmpdir(), "cotal-seat-native-"));
  try {
    const { include, library } = fetchNodeSdk(work);
    const obj = join(work, "peercred.obj");
    const built = join(work, "peercred.node");
    const run = (file, args) => {
      const result = spawnSync(file, args, { cwd: work, encoding: "utf8" });
      if (result.status !== 0 || result.error) {
        const detail = result.error ? result.error.message : `${result.stderr || result.stdout || `${file} exited ${result.status ?? 1}`}`;
        fail([`@cotal-ai/seat: failed to compile the named-pipe helper for win32-${arch}.`, `command: ${file} ${args.join(" ")}`, detail.trim() || "(no compiler diagnostic)",
          "Visual Studio C++ build tools are required to BUILD this package from source on Windows. Published tarballs ship the prebuilt helpers and do not compile on install."], result.status ?? 1);
      }
    };
    run("cl.exe", ["/nologo", "/c", "/O2", "/MT", "/W4", "/std:c11", `/I${include}`, `/Fo${obj}`, join(root, "native", "peercred_win32.c")]);
    run("link.exe", ["/nologo", "/DLL", "/Brepro", `/OUT:${built}`, obj, library, "kernel32.lib", "advapi32.lib"]);
    const buf = readFileSync(built);
    const pe = buf.length >= 0x40 ? buf.readUInt32LE(0x3c) : 0;
    if (buf.subarray(0, 2).toString("ascii") !== "MZ" || buf.length < pe + 6 || buf.subarray(pe, pe + 4).toString("latin1") !== "PE\0\0") {
      fail([`@cotal-ai/seat: ${built} is not a PE file`]);
    }
    const machine = buf.readUInt16LE(pe + 4);
    if (machine !== expected) fail([`@cotal-ai/seat: win32-${arch} helper has PE machine 0x${machine.toString(16)}, expected 0x${expected.toString(16)}.`]);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(built, join(outDir, "peercred.node"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The Node headers and import library the helper links against: the workspace binding's pinned
 *  SDK (`packages/workspace/native/node-sdk.json`), downloaded from nodejs.org and checked against
 *  its recorded digests, so both native packages build against one pinned Node. */
function fetchNodeSdk(work) {
  const pin = JSON.parse(readFileSync(join(root, "..", "workspace", "native", "node-sdk.json"), "utf8"));
  const fetchChecked = (path, expected, output) => {
    const result = spawnSync("curl.exe", ["--fail", "--silent", "--show-error", "--location", "--max-time", "120", "--output", output, `https://nodejs.org/dist/v${pin.version}/${path}`], { encoding: "utf8" });
    if (result.status !== 0 || result.error) fail([`@cotal-ai/seat: Node SDK download failed for ${path}: ${result.error ? result.error.message : result.stderr.trim()}`]);
    const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
    if (digest !== expected) fail([`@cotal-ai/seat: Node SDK checksum mismatch for ${path}: ${digest}, expected ${expected}`]);
  };
  const headers = join(work, "headers.tar.gz");
  const library = join(work, "node.lib");
  fetchChecked(`node-v${pin.version}-headers.tar.gz`, pin.headers, headers);
  fetchChecked(`win-${arch}/node.lib`, pin.libraries[arch], library);
  const extract = spawnSync("tar.exe", ["-xzf", headers, "-C", work], { encoding: "utf8" });
  if (extract.status !== 0 || extract.error) fail([`@cotal-ai/seat: could not extract the Node headers: ${extract.error ? extract.error.message : extract.stderr.trim()}`]);
  return { include: join(work, `node-v${pin.version}`, "include", "node"), library };
}

if (platform !== "linux") process.exit(0);

const include = join(dirname(process.execPath), "..", "include", "node");
const ptyArch = process.arch;
const ELF_MACHINE = { x64: 62, arm64: 183 };
const expectedMachine = ELF_MACHINE[ptyArch];
if (expectedMachine === undefined) fail([`@cotal-ai/seat: pidfd-patched PTY native addon unsupported on linux-${ptyArch} (supported: linux-x64, linux-arm64)`]);
if (!existsSync(join(include, "node_api.h"))) fail([`@cotal-ai/seat: node_api.h not found at ${include} (from ${process.execPath}). A source build needs the Node headers that ship next to that binary.`]);

function compile(tool, args, what) {
  const result = spawnSync(tool, args, { cwd: root, encoding: "utf8" });
  if (result.status === 0 && !result.error) return;
  const detail = result.error ? result.error.message : `${result.stderr || result.stdout || `${tool} exited ${result.status ?? 1}`}`;
  fail([`@cotal-ai/seat: failed to compile the ${what} for linux-${arch}.`, `command: ${tool} ${args.join(" ")}`, detail.trim() || "(no compiler diagnostic)", "A C and C++ compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helpers and do not compile on install."], result.status ?? 1);
}

function elfMachine(path) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") throw new Error(`${path} is not an ELF file`);
  return buf.readUInt16LE(18);
}

function assertMachine(path, what) {
  let machine;
  try {
    machine = elfMachine(path);
  } catch (err) {
    fail([`@cotal-ai/seat: ${err instanceof Error ? err.message : String(err)}`]);
  }
  if (machine !== expectedMachine) fail([`@cotal-ai/seat: linux-${arch} ${what} at ${path} has ELF e_machine ${machine}, expected ${expectedMachine}.`]);
}

const vendor = join(root, "native", "node-pty");
const upstream = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
const pristine = mkdtempSync(join(tmpdir(), "cotal-seat-node-pty-"));
try {
  for (const file of Object.keys(upstream.files)) cpSync(join(vendor, file), join(pristine, file));
  const reversed = spawnSync("patch", ["-R", "-p1", "-s", "-d", pristine, "-i", join(vendor, upstream.patch)], { encoding: "utf8" });
  if (reversed.status !== 0 || reversed.error) fail([`@cotal-ai/seat: ${upstream.patch} does not reverse-apply to native/node-pty: ${reversed.error?.message ?? reversed.stdout + reversed.stderr}`]);
  const drift = Object.entries(upstream.files).filter(([file, sha]) => createHash("sha256").update(readFileSync(join(pristine, file))).digest("hex") !== sha);
  if (drift.length > 0) fail([`@cotal-ai/seat: native/node-pty differs from node-pty@${upstream.version} plus ${upstream.patch}: ${drift.map(([file]) => file).join(", ")}`]);
} finally {
  rmSync(pristine, { recursive: true, force: true });
}

const addonApi = dirname(createRequire(import.meta.url).resolve("node-addon-api/package.json"));
const ptyOut = join(outDir, "pty.node");
compile("c++", ["-shared", "-fPIC", "-O2", "-fstack-protector-strong", "-Wall", "-std=gnu++17", "-DNAPI_CPP_EXCEPTIONS", "-DNODE_GYP_MODULE_NAME=pty", `-I${include}`, `-I${addonApi}`, "-o", ptyOut, join(vendor, "src", "unix", "pty.cc"), "-lutil"], "pidfd-patched node-pty addon");
assertMachine(ptyOut, "pty addon");
