#!/usr/bin/env node
/**
 * Developer compile of the Linux SO_PEERCRED helper and the pidfd-patched node-pty addon for THIS
 * host arch.
 *
 * Customer `npm i` does not run this. A publishable tree is assembled in CI
 * from native linux-x64 and linux-arm64 builder artifacts. This script never
 * cross-compiles and never skips an arch: it only builds the host.
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

if (process.platform !== "linux") {
  process.exit(0);
}

const src = join(root, "native", "peercred.c");
const include = join(dirname(process.execPath), "..", "include", "node");
if (!existsSync(join(include, "node_api.h"))) {
  console.error(
    `@cotal-ai/seat: node_api.h not found at ${include} (from ${process.execPath}). A source build needs the Node headers that ship next to that binary.`,
  );
  process.exit(1);
}

/** ELF e_machine: EM_X86_64=62, EM_AARCH64=183. */
const ELF_MACHINE = { x64: 62, arm64: 183 };
const arch = process.arch;
const expectedMachine = ELF_MACHINE[arch];
if (expectedMachine === undefined) {
  console.error(
    `@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-${arch} (supported: linux-x64, linux-arm64)`,
  );
  process.exit(1);
}

console.error(
  `@cotal-ai/seat: host dev build for linux-${arch}. This is not a publishable tree. Pack and publish require both linux-x64 (ELF e_machine 62) and linux-arm64 (ELF e_machine 183), assembled from native builder jobs.`,
);

const stale = join(releaseRoot, "peercred.node");
if (existsSync(stale)) rmSync(stale);

function elfMachine(path) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") {
    throw new Error(`${path} is not an ELF file`);
  }
  return buf.readUInt16LE(18);
}

function compile(tool, args, what) {
  const result = spawnSync(tool, args, { cwd: root, encoding: "utf8" });
  if (result.status === 0 && !result.error) return;
  const detail = result.error ? result.error.message : `${result.stderr || result.stdout || `${tool} exited ${result.status ?? 1}`}`;
  console.error(`@cotal-ai/seat: failed to compile the ${what} for linux-${arch}.`);
  console.error(`command: ${tool} ${args.join(" ")}`);
  console.error(detail.trim() || "(no compiler diagnostic)");
  console.error(
    "A C and C++ compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helpers and do not compile on install.",
  );
  process.exit(result.status ?? 1);
}

function assertMachine(out, what) {
  let machine;
  try {
    machine = elfMachine(out);
  } catch (err) {
    console.error(`@cotal-ai/seat: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (machine !== expectedMachine) {
    console.error(`@cotal-ai/seat: linux-${arch} ${what} at ${out} has ELF e_machine ${machine}, expected ${expectedMachine}.`);
    process.exit(1);
  }
}

const outDir = join(releaseRoot, `linux-${arch}`);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "peercred.node");
compile("cc", ["-shared", "-fPIC", "-D_GNU_SOURCE", "-o", out, src, `-I${include}`], "SO_PEERCRED helper");
assertMachine(out, "helper");

// The vendored node-pty must be upstream plus pidfd.patch and nothing else: reverse the patch on a
// copy and require every file to hash to its recorded upstream sha256.
const vendor = join(root, "native", "node-pty");
const upstream = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
const pristine = mkdtempSync(join(tmpdir(), "cotal-seat-node-pty-"));
try {
  for (const file of Object.keys(upstream.files)) cpSync(join(vendor, file), join(pristine, file));
  const reversed = spawnSync("patch", ["-R", "-p1", "-s", "-d", pristine, "-i", join(vendor, upstream.patch)], { encoding: "utf8" });
  if (reversed.status !== 0 || reversed.error) {
    console.error(`@cotal-ai/seat: ${upstream.patch} does not reverse-apply to native/node-pty: ${reversed.error?.message ?? reversed.stdout + reversed.stderr}`);
    process.exit(1);
  }
  const drift = Object.entries(upstream.files).filter(
    ([file, sha]) => createHash("sha256").update(readFileSync(join(pristine, file))).digest("hex") !== sha,
  );
  if (drift.length > 0) {
    console.error(
      `@cotal-ai/seat: native/node-pty differs from node-pty@${upstream.version} plus ${upstream.patch}: ${drift.map(([f]) => f).join(", ")}`,
    );
    process.exit(1);
  }
} finally {
  rmSync(pristine, { recursive: true, force: true });
}

const addonApi = dirname(createRequire(import.meta.url).resolve("node-addon-api/package.json"));
const ptyOut = join(outDir, "pty.node");
compile(
  "c++",
  [
    "-shared", "-fPIC", "-O2", "-fstack-protector-strong", "-Wall", "-std=gnu++17",
    "-DNAPI_CPP_EXCEPTIONS", "-DNODE_GYP_MODULE_NAME=pty",
    `-I${include}`, `-I${addonApi}`,
    "-o", ptyOut, join(vendor, "src", "unix", "pty.cc"), "-lutil",
  ],
  "pidfd-patched node-pty addon",
);
assertMachine(ptyOut, "pty addon");
