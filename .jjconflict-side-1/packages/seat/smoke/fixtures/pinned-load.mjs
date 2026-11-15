/**
 * Load probe for an installed @cotal-ai/seat: the shipped pty.node forks a pinned child and the
 * handle reaches it only through the pidfd. Shared by the x64 installed-dist smoke and the arm64
 * load job, both run against the packed tarball with no toolchain.
 *
 * usage: node pinned-load.mjs <installed seat package dir>
 * Prints one `PINNED_LOAD <json>` line; exits 0 only when every step held.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.argv[2];
const got = {};
const done = (ok) => {
  console.log(`PINNED_LOAD ${JSON.stringify({ ok, ...got })}`);
  process.exit(ok ? 0 : 1);
};
try {
  try {
    createRequire(join(pkg, "package.json")).resolve("@lydell/node-pty");
    got.lydell = "resolved";
  } catch (e) {
    got.lydell = e.code ?? "unresolved";
  }
  const { spawnPinned } = await import(pathToFileURL(join(pkg, "dist", "index.js")).href);
  const pty = spawnPinned("sh", ["-c", "read x"], { name: "xterm", cols: 80, rows: 24, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const exit = new Promise((resolve) => pty.onExit(resolve));
  got.pid = pty.pid;
  // The handle hides its pidfd, so find it the way the kernel names it.
  const fd = readdirSync("/proc/self/fd").find((n) => {
    try {
      return readlinkSync(`/proc/self/fd/${n}`) === "anon_inode:[pidfd]";
    } catch {
      return false;
    }
  });
  got.fdinfoPid = fd === undefined ? null : Number(/^Pid:\s*(-?\d+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1]);
  got.exitedBefore = pty.handle.exited();
  got.first = pty.handle.signal("SIGKILL");
  await exit;
  got.exitedAfter = pty.handle.exited();
  got.second = pty.handle.signal("SIGKILL");
  done(
    got.lydell === "MODULE_NOT_FOUND" &&
      got.fdinfoPid === pty.pid &&
      got.exitedBefore === false &&
      got.first === "sent" &&
      got.exitedAfter === true &&
      got.second === "gone",
  );
} catch (e) {
  got.error = e instanceof Error ? e.stack ?? e.message : String(e);
  done(false);
}
