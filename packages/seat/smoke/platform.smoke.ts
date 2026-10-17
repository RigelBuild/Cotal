/**
 * Platform loud-fail for custody transport. Linux is the production transport.
 * Other platforms must throw the named error and print a completion banner.
 * No top-of-file skip. References #1297.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedTransport } from "../src/protocol.js";
import { nativeHelperPath, unsupportedNativeArch } from "../src/peercred.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};

const err = unsupportedTransport("darwin");
check(
  "darwin throws custody transport unsupported on darwin",
  err instanceof Error && err.message === "custody transport unsupported on darwin",
  err.message,
);
const win = unsupportedTransport("win32");
check(
  "win32 throws custody transport unsupported on win32",
  win instanceof Error && win.message === "custody transport unsupported on win32",
  win.message,
);
const linux = unsupportedTransport("linux");
check(
  "named error is still formed for linux so the helper never silently no-ops",
  linux.message === "custody transport unsupported on linux",
);

if (process.platform !== "linux") {
  const { launchSeat } = await import("../src/launcher.js");
  let threw = "";
  try {
    launchSeat({
      root: "/tmp/cotal-seat-should-not-exist",
      name: "nope",
      spec: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      cwd: process.cwd(),
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `launchSeat throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(here, "..");
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
    scripts?: { install?: string; prepack?: string; prepare?: string; prepublishOnly?: string; "build:ts"?: string };
    files?: string[];
    dependencies?: Record<string, string>;
  };
  check(
    "the seat declares no @lydell/node-pty dependency: its PTY is the vendored, pidfd-patched build",
    manifest.dependencies?.["@lydell/node-pty"] === undefined,
    manifest.dependencies,
  );
  check("customer install does not compile: package.json has no install script", manifest.scripts?.install === undefined, manifest.scripts);
  check(
    "prepack asserts shipped natives and compiles TypeScript only",
    manifest.scripts?.prepack === "node scripts/assert-shipped-natives.mjs && pnpm run build:ts",
    manifest.scripts,
  );
  check(
    "prepublishOnly asserts shipped natives and compiles TypeScript only",
    manifest.scripts?.prepublishOnly === "node scripts/assert-shipped-natives.mjs && pnpm run build:ts",
    manifest.scripts,
  );
  check("the TypeScript-only build does not rebuild natives", manifest.scripts?.["build:ts"] === "tsc -p tsconfig.json", manifest.scripts);
  check(
    "prepare is absent so install-from-git is not gated",
    manifest.scripts?.prepare === undefined,
    manifest.scripts,
  );
  check(
    "no binding.gyp so npm/pnpm will not infer node-gyp rebuild on install",
    !existsSync(join(pkgRoot, "binding.gyp")),
  );
  check(
    "published files list is the prebuilt output and the vendored node-pty runtime, not the compiler sources",
    JSON.stringify(manifest.files) ===
      JSON.stringify(["dist", "build", "native/node-pty/lib", "native/node-pty/package.json", "native/node-pty/LICENSE"]),
    manifest.files,
  );

  if (process.platform !== "linux") {
    const compile = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-native.mjs")], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    check(
      "source compile is a no-op off linux so Windows build does not need headers or a C compiler",
      compile.status === 0,
      { status: compile.status, stdout: compile.stdout, stderr: compile.stderr },
    );
  }

  if (process.platform === "linux") {
  {
    const blocked = mkdtempSync(join(tmpdir(), "cotal-seat-ncc-"));
    try {
      const bin = join(blocked, "bin");
      mkdirSync(bin);
      for (const name of ["cc", "gcc", "g++", "c++", "make", "node-gyp"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, name), 0o755);
      }
      const helper = nativeHelperPath();
      const saved = existsSync(helper) ? join(blocked, "peercred.node") : undefined;
      if (saved) copyFileSync(helper, saved);
      const compile = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-native.mjs")], {
        cwd: pkgRoot,
        encoding: "utf8",
        env: childEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }),
      });
      if (saved) copyFileSync(saved, helper);
      check(
        "source compile without a C compiler fails with a diagnostic",
        compile.status !== 0 && /failed to compile the SO_PEERCRED helper/.test(`${compile.stdout}\n${compile.stderr}`),
        { status: compile.status, stdout: compile.stdout, stderr: compile.stderr },
      );
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  }

  {
    const reloc = mkdtempSync(join(tmpdir(), "cotal-seat-reloc-"));
    try {
      const bin = join(reloc, "bin");
      const includeDir = join(reloc, "include", "node");
      const ccDir = join(reloc, "cc");
      mkdirSync(bin);
      mkdirSync(includeDir, { recursive: true });
      mkdirSync(ccDir);
      copyFileSync(process.execPath, join(bin, "node"));
      writeFileSync(join(includeDir, "node_api.h"), "");
      const argvLog = join(reloc, "cc-argv.txt");
      writeFileSync(
        join(ccDir, "cc"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit 0\n`,
      );
      chmodSync(join(ccDir, "cc"), 0o755);
      const helper = nativeHelperPath();
      const saved = existsSync(helper) ? join(reloc, "peercred.node") : undefined;
      if (saved) copyFileSync(helper, saved);
      const compile = spawnSync(join(bin, "node"), [join(pkgRoot, "scripts", "build-native.mjs")], {
        cwd: pkgRoot,
        encoding: "utf8",
        env: childEnv({ PATH: `${ccDir}:${process.env.PATH ?? ""}` }),
      });
      if (saved) copyFileSync(saved, helper);
      const argv = existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
      const expectedInclude = join(dirname(realpathSync(join(bin, "node"))), "..", "include", "node");
      check("relocated-node source compile invoked cc", existsSync(argvLog), {
        status: compile.status,
        stdout: compile.stdout,
        stderr: compile.stderr,
      });
      check(
        "source compile uses the running Node include dir, not /usr/include/node",
        argv.split("\n").includes(`-I${expectedInclude}`) && !argv.includes("-I/usr/include/node"),
        argv,
      );
    } finally {
      rmSync(reloc, { recursive: true, force: true });
    }
  }

  {
    const unsupported = unsupportedNativeArch("linux", "riscv64");
    check(
      "unsupported linux arch is loud",
      unsupported.message ===
        "@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-riscv64 (supported: linux-x64, linux-arm64)",
      unsupported.message,
    );
    check(
      "loader selects the host arch helper",
      nativeHelperPath().replaceAll("\\", "/").endsWith(`/linux-${process.arch}/peercred.node`),
      nativeHelperPath(),
    );
    check(
      "host linux helper is keyed, not unkeyed Release/peercred.node",
      existsSync(nativeHelperPath()) && !existsSync(join(pkgRoot, "build", "Release", "peercred.node")),
    );
  }

  {
    const tree = mkdtempSync(join(tmpdir(), "cotal-seat-assert-"));
    const writeElf = (arch: string, machine: number): void => {
      for (const file of ["peercred.node", "pty.node"]) {
        const path = join(tree, "build", "Release", `linux-${arch}`, file);
        mkdirSync(dirname(path), { recursive: true });
        const buf = Buffer.alloc(20);
        buf[0] = 0x7f;
        buf.write("ELF", 1);
        buf.writeUInt16LE(machine, 18);
        writeFileSync(path, buf);
      }
    };
    try {
      writeElf("x64", 62);
      const oneArch = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertShippedNatives } from ${JSON.stringify(join(pkgRoot, "scripts", "assert-shipped-natives.mjs"))}; assertShippedNatives(process.argv[1]);`,
          tree,
        ],
        { encoding: "utf8" },
      );
      check(
        "one-arch tree is refused before pack",
        oneArch.status === 1 &&
          /linux-arm64 helper was not assembled into the publish tree/.test(`${oneArch.stdout}\n${oneArch.stderr}`),
        { status: oneArch.status, stdout: oneArch.stdout, stderr: oneArch.stderr },
      );
      writeElf("arm64", 183);
      const both = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertShippedNatives } from ${JSON.stringify(join(pkgRoot, "scripts", "assert-shipped-natives.mjs"))}; assertShippedNatives(process.argv[1]);`,
          tree,
        ],
        { encoding: "utf8" },
      );
      check("assembled linux-x64 plus linux-arm64 is packable", both.status === 0, {
        status: both.status,
        stdout: both.stdout,
        stderr: both.stderr,
      });
      rmSync(join(tree, "build", "Release", "linux-arm64", "pty.node"));
      const noPty = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertShippedNatives } from ${JSON.stringify(join(pkgRoot, "scripts", "assert-shipped-natives.mjs"))}; assertShippedNatives(process.argv[1]);`,
          tree,
        ],
        { encoding: "utf8" },
      );
      check(
        "a tree missing one arch's pty.node is refused before pack",
        noPty.status === 1 && /native helper missing at .*linux-arm64\/pty\.node/.test(`${noPty.stdout}\n${noPty.stderr}`),
        { status: noPty.status, stdout: noPty.stdout, stderr: noPty.stderr },
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  {
    // The host build's pty.node must hand back a pidfd: a prebuilt without the patch spawns fine
    // and only fails here.
    // tsx's NODE_PATH reaches the whole pnpm store; drop it so resolution is the package's own.
    const probe = spawnSync(process.execPath, [join(here, "fixtures", "pinned-load.mjs"), pkgRoot], {
      encoding: "utf8",
      timeout: 30_000,
      env: childEnv({ NODE_PATH: "" }),
    });
    const line = /^PINNED_LOAD (.*)$/m.exec(probe.stdout ?? "")?.[1];
    const report: unknown = line === undefined ? undefined : JSON.parse(line);
    check(
      "the host-built pty.node pins its child: fdinfo Pid matches, SIGKILL is sent, then exited and gone",
      probe.status === 0 && typeof report === "object" && report !== null && "ok" in report && report.ok === true,
      { status: probe.status, stdout: probe.stdout, stderr: probe.stderr },
    );
  }

  const NATIVES = ["peercred.node", "pty.node"];
  const backupNatives = (into: string): Array<{ dest: string; backup?: string }> => {
    const saved: Array<{ dest: string; backup?: string }> = [];
    for (const arch of ["x64", "arm64"]) {
      for (const file of NATIVES) {
        const dest = join(pkgRoot, "build", "Release", `linux-${arch}`, file);
        const backup = existsSync(dest) ? join(into, `saved-${arch}-${file}`) : undefined;
        if (backup) copyFileSync(dest, backup);
        saved.push({ dest, backup });
      }
    }
    return saved;
  };
  // A native builder artifact is its whole linux-<arch>/ directory: both .node files.
  const writeBuilderDir = (under: string, arch: string, machine: number): string => {
    const dir = join(under, `seat-native-linux-${arch}`);
    mkdirSync(dir, { recursive: true });
    for (const file of NATIVES) {
      const buf = Buffer.alloc(20);
      buf[0] = 0x7f;
      buf.write("ELF", 1);
      buf.writeUInt16LE(machine, 18);
      writeFileSync(join(dir, file), buf);
    }
    return dir;
  };

  {
    const sources = mkdtempSync(join(tmpdir(), "cotal-seat-asm-src-"));
    const saved = backupNatives(sources);
    try {
      for (const { dest } of saved) if (existsSync(dest)) rmSync(dest);
      const x64 = writeBuilderDir(sources, "x64", 62);
      const arm64 = writeBuilderDir(sources, "arm64", 183);
      const assembled = spawnSync(
        process.execPath,
        [join(pkgRoot, "..", "..", "scripts", "seat-assemble-natives.mjs"), "--x64", x64, "--arm64", arm64],
        { encoding: "utf8" },
      );
      check(
        "assemble copies both native builder artifacts",
        assembled.status === 0 && saved.every(({ dest }) => existsSync(dest)),
        { status: assembled.status, stdout: assembled.stdout, stderr: assembled.stderr },
      );
    } finally {
      for (const { dest, backup } of saved) {
        if (backup) copyFileSync(backup, dest);
        else if (existsSync(dest)) rmSync(dest);
      }
      rmSync(sources, { recursive: true, force: true });
    }
  }

  const packDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-"));
  const packState = mkdtempSync(join(tmpdir(), "cotal-seat-pack-state-"));
  const savedPack = backupNatives(packState);
  try {
    const otherArch = process.arch === "x64" ? "arm64" : "x64";
    for (const file of NATIVES) rmSync(join(pkgRoot, "build", "Release", `linux-${otherArch}`, file), { force: true });

    // Inspect a host-only tree without running prepack.
    const packed = spawnSync("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", packDir], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    check("pnpm pack wrote a tarball", packed.status === 0 && tarball !== undefined, {
      status: packed.status,
      stderr: packed.stderr,
      files: readdirSync(packDir),
    });
    if (tarball) {
      const listing = spawnSync("tar", ["-tzf", join(packDir, tarball)], { encoding: "utf8" });
      const files = listing.stdout.split("\n").filter(Boolean);
      check(
        "a host-only pack does not ship the other linux arch or an unkeyed helper",
        NATIVES.every((file) => files.includes(`package/build/Release/linux-${process.arch}/${file}`)) &&
          !files.some((f) => f.startsWith(`package/build/Release/linux-${otherArch}/`)) &&
          !files.includes("package/build/Release/peercred.node"),
        files.filter((f) => f.includes("peercred") || f.includes("build/")),
      );
      check(
        "the tarball does not ship compiler sources",
        !files.some((f) => f === "package/native/peercred.c" || f === "package/binding.gyp" || f === "package/scripts/build-native.mjs"),
        files.filter((f) => f.includes("native") || f.includes("binding") || f.includes("build-native")),
      );
    }

    const refuseDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-gated-"));
    const gated = spawnSync("pnpm", ["pack", "--pack-destination", refuseDir], { cwd: pkgRoot, encoding: "utf8" });
    check(
      "host-only pnpm pack is refused by prepack",
      gated.status !== 0,
      { status: gated.status, stdout: gated.stdout, stderr: gated.stderr },
    );
    rmSync(refuseDir, { recursive: true, force: true });

    const assembled = spawnSync(
      process.execPath,
      [
        join(pkgRoot, "..", "..", "scripts", "seat-assemble-natives.mjs"),
        "--x64",
        writeBuilderDir(packState, "x64", 62),
        "--arm64",
        writeBuilderDir(packState, "arm64", 183),
      ],
      { encoding: "utf8" },
    );
    check(
      "pack proof assembled both native builder artifacts",
      assembled.status === 0 && savedPack.every(({ dest }) => existsSync(dest)),
      { status: assembled.status, stdout: assembled.stdout, stderr: assembled.stderr },
    );
    rmSync(join(pkgRoot, "dist"), { recursive: true, force: true });
    check("assembled package inventory starts with no dist directory", !existsSync(join(pkgRoot, "dist")));
    const succeedDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-assembled-"));
    const assembledPack = spawnSync("pnpm", ["pack", "--pack-destination", succeedDir], { cwd: pkgRoot, encoding: "utf8" });
    check(
      "assembled tree packs with scripts",
      assembledPack.status === 0,
      { status: assembledPack.status, stdout: assembledPack.stdout, stderr: assembledPack.stderr },
    );
    const assembledTarball = readdirSync(succeedDir).find((name) => name.endsWith(".tgz"));
    if (assembledTarball) {
      const listing = spawnSync("tar", ["-tzf", join(succeedDir, assembledTarball)], { encoding: "utf8" });
      const files = listing.stdout.split("\n").filter(Boolean);
      check(
        "the tarball ships keyed linux-x64 and linux-arm64 helpers",
        ["x64", "arm64"].every((arch) => NATIVES.every((file) => files.includes(`package/build/Release/linux-${arch}/${file}`))) &&
          !files.includes("package/build/Release/peercred.node"),
        files.filter((f) => f.includes("peercred") || f.includes("build/")),
      );
      check(
        "the tarball ships the vendored node-pty runtime and not its C++ source",
        files.includes("package/native/node-pty/lib/unixTerminal.js") &&
          files.includes("package/native/node-pty/package.json") &&
          files.includes("package/native/node-pty/LICENSE") &&
          !files.some((f) => f.startsWith("package/native/node-pty/src/") || f === "package/native/node-pty/pidfd.patch"),
        files.filter((f) => f.includes("native/")),
      );
      check("the tarball ships dist/index.js compiled by prepack", files.includes("package/dist/index.js"), files);
      check("the tarball ships dist/index.d.ts compiled by prepack", files.includes("package/dist/index.d.ts"), files);
    }
    rmSync(succeedDir, { recursive: true, force: true });
  } finally {
    for (const { dest, backup } of savedPack) {
      if (backup) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(backup, dest);
      } else if (existsSync(dest)) {
        rmSync(dest);
        try {
          rmSync(dirname(dest));
        } catch {
          /* directory still holds other files */
        }
      }
    }
    rmSync(packDir, { recursive: true, force: true });
    rmSync(packState, { recursive: true, force: true });
  }
  }
}

console.log(`\nSEAT PLATFORM ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (process.platform !== "linux") {
  console.log(`SEAT PLATFORM COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
}
process.exitCode = fail === 0 ? 0 : 1;
