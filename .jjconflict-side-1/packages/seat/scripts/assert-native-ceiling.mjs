#!/usr/bin/env node
/**
 * Native-job gate: refuse a host build whose .node files need a newer glibc, libstdc++ or C++ ABI
 * than the seat README promises. Measured on ubuntu:24.04 (the ubuntu-latest image), pty.node
 * needs GLIBC_2.34 (forkpty), GLIBCXX_3.4.22 and CXXABI_1.3.9; peercred.node needs GLIBC_2.4.
 *
 * usage: assert-native-ceiling.mjs [dir]   default: build/Release/linux-<process.arch>
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_CEILING = { GLIBC: "2.34", GLIBCXX: "3.4.22", CXXABI: "1.3.9" };

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const dir = process.argv[2] ?? join(root, "build", "Release", `linux-${process.arch}`);

const newer = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};

const over = [];
for (const file of ["peercred.node", "pty.node"]) {
  const path = join(dir, file);
  const elf = spawnSync("readelf", ["-V", "--wide", path], { encoding: "utf8" });
  if (elf.status !== 0 || elf.error) {
    console.error(`@cotal-ai/seat: readelf -V failed on ${path}: ${elf.error?.message ?? elf.stderr}`);
    process.exit(1);
  }
  const highest = {};
  for (const [, family, version] of elf.stdout.matchAll(/Name: (GLIBC|GLIBCXX|CXXABI)_([0-9.]+)/g)) {
    if (highest[family] === undefined || newer(version, highest[family])) highest[family] = version;
  }
  console.log(`${path}: ${JSON.stringify(highest)}`);
  for (const [family, version] of Object.entries(highest)) {
    if (newer(version, NATIVE_CEILING[family])) over.push(`${file} needs ${family}_${version} (ceiling ${family}_${NATIVE_CEILING[family]})`);
  }
}
if (over.length > 0) {
  for (const line of over) console.error(`@cotal-ai/seat: ${line}`);
  console.error("@cotal-ai/seat: this build raises the published glibc floor; build on the pinned runner or update the README floor and NATIVE_CEILING together.");
  process.exit(1);
}
