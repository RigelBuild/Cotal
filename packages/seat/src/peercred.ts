import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { unsupportedTransport } from "./protocol.js";

export interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}


type PeercredNative = {
  peercred: (fd: number) => PeerCredentials;
  flockExclusiveNb?: (fd: number) => boolean;
  processStartTime?: (pid: number) => string | undefined;
  userCacheDir?: () => string;
  launchdJob?: (label: string) => unknown;
  tryLockFd?: (fd: number) => boolean;
  pidfdSignal?: (pidfd: number, signal: "SIGTERM" | "SIGKILL") => "sent" | "gone";
  pidfdExited?: (pidfd: number) => boolean;
  pidfdOpen?: (pid: number) => number | null;
};

export const LINUX_NATIVE_ARCHES = ["x64", "arm64"] as const;
/** The platforms and arches the helper has a source build for. Seat custody uses only Linux; the
 *  host primitives in host.ts use all of them. */
export const NATIVE_TARGETS = { linux: LINUX_NATIVE_ARCHES, darwin: ["x64", "arm64"], win32: ["x64", "arm64"] } as const;

let loaded: unknown;

export function nativeHelperPath(arch: string = process.arch, platform: string = process.platform): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "build", "Release", `${platform}-${arch}`, "peercred.node");
}

/** Load the helper for this platform and arch, or throw naming what is missing. Never compiles. */
export function loadNativeHelper<T>(): T {
  if (loaded) return loaded as T;
  const platformArch = `${process.platform}-${process.arch}`;
  const arches = (NATIVE_TARGETS as Record<string, readonly string[]>)[process.platform];
  if (!arches?.includes(process.arch)) {
    const supported = Object.entries(NATIVE_TARGETS).flatMap(([p, a]) => a.map((x) => `${p}-${x}`)).join(", ");
    throw new Error(`@cotal-ai/seat: native helper unsupported on ${platformArch} (supported: ${supported})`);
  }
  const path = nativeHelperPath();
  if (!existsSync(path)) throw new Error(`@cotal-ai/seat: native helper missing at ${path}`);
  const require = createRequire(import.meta.url);
  try {
    loaded = require(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`@cotal-ai/seat: native helper failed to load at ${path} for ${platformArch}: ${detail}`);
  }
  return loaded as T;
}

function isLinuxNativeArch(arch: string): arch is (typeof LINUX_NATIVE_ARCHES)[number] {
  return (LINUX_NATIVE_ARCHES as readonly string[]).includes(arch);
}

export function unsupportedNativeArch(platform: string, arch: string): Error {
  return new Error(
    `@cotal-ai/seat: SO_PEERCRED native helper unsupported on ${platform}-${arch} (supported: linux-x64, linux-arm64)`,
  );
}

function loadLinuxNative(): PeercredNative {
  if (process.platform !== "linux") throw unsupportedTransport();
  if (!isLinuxNativeArch(process.arch)) throw unsupportedNativeArch(process.platform, process.arch);
  return loadNativeHelper<PeercredNative>();
}

export function socketFd(sock: Socket): number {
  const handle = (sock as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || fd < 0) throw new Error("unix socket has no file descriptor");
  return fd;
}

export function peerCredentials(sock: Socket): PeerCredentials {
  return loadNativeHelper<PeercredNative>().peercred(socketFd(sock));
}

/** Exclusive non-blocking `flock(2)`; the kernel releases it when the last descriptor closes. */
export function flockExclusiveNb(fd: number): boolean {
  const lock = loadNativeHelper<PeercredNative>().flockExclusiveNb;
  if (!lock) throw new Error("@cotal-ai/seat: flockExclusiveNb is unavailable on this native helper");
  return lock(fd);
}

/** Lock the launch fence if no other open file description holds it. */
export function tryLockFd(fd: number): boolean {
  const lock = loadLinuxNative().tryLockFd;
  if (!lock) throw new Error("@cotal-ai/seat: tryLockFd is unavailable on this native helper");
  return lock(fd);
}

/** Send only supported signals through a pinned pidfd. */
export function pidfdSignal(pidfd: number, signal: "SIGTERM" | "SIGKILL"): "sent" | "gone" {
  const send = loadLinuxNative().pidfdSignal;
  if (!send) throw new Error("@cotal-ai/seat: pidfdSignal is unavailable on this native helper");
  return send(pidfd, signal);
}

/** Open a process reference by pid, returning undefined when it has already exited. */
export function pidfdOpen(pid: number): number | undefined {
  const open = loadLinuxNative().pidfdOpen;
  if (!open) throw new Error("@cotal-ai/seat: pidfdOpen is unavailable on this native helper");
  return open(pid) ?? undefined;
}

/** Read exit state from a pinned pidfd. */
export function pidfdExited(pidfd: number): boolean {
  const exited = loadLinuxNative().pidfdExited;
  if (!exited) throw new Error("@cotal-ai/seat: pidfdExited is unavailable on this native helper");
  return exited(pidfd);
}
