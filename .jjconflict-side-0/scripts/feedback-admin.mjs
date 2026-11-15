#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.env.COTAL_ROOT ?? process.cwd());
const keysPath = resolve(process.env.COTAL_FEEDBACK_KEYS ?? `${root}/.cotal/feedback/keys.json`);
const feedbackPath = resolve(process.env.COTAL_FEEDBACK_STORE ?? `${root}/.cotal/feedback/feedback.jsonl`);
const startScript = resolve(process.env.COTAL_FEEDBACK_START ?? `${root}/.cotal/bin/start-feedback-stack.sh`);

const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.log(`Usage: feedback-admin <command> [args]

Commands:
  list-keys
      Show configured beta tester keys without printing secrets.

  add-key <tester> [--name <display-name>]
      Create a new per-tester feedback key, save it, restart intake, and print the key once.

  revoke-key <tester-or-key>
      Remove matching tester/key entries, write a backup, and restart intake.

  rotate-key <tester> [--name <display-name>]
      Revoke existing entries for tester, create a new key, restart intake, and print it once.

  pull [--limit <n>] [--json] [--tester <id>] [--origin human|agent] [--type <type>]
      Print recent feedback from the JSONL source of truth.

  restart
      Restart the local feedback intake stack.

Environment:
  COTAL_ROOT              Repo root. Default: current directory.
  COTAL_FEEDBACK_KEYS     Default: <root>/.cotal/feedback/keys.json
  COTAL_FEEDBACK_STORE    Default: <root>/.cotal/feedback/feedback.jsonl
  COTAL_FEEDBACK_START    Default: <root>/.cotal/bin/start-feedback-stack.sh
`);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { flags, positional };
}

function readKeys() {
  if (!existsSync(keysPath)) return { keys: [] };
  const parsed = JSON.parse(readFileSync(keysPath, "utf8"));
  if (!parsed || !Array.isArray(parsed.keys)) throw new Error(`${keysPath} must contain { "keys": [...] }`);
  return parsed;
}

function writeKeys(data) {
  mkdirSync(dirname(keysPath), { recursive: true });
  if (existsSync(keysPath)) {
    const backup = `${keysPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    renameSync(keysPath, backup);
  }
  writeFileSync(keysPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function newKey() {
  return `fbk_${randomBytes(24).toString("base64url")}`;
}

function masked(key) {
  if (typeof key !== "string" || key.length < 12) return "<invalid>";
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

function restart() {
  if (!existsSync(startScript)) {
    console.error(`restart skipped: ${startScript} not found`);
    return;
  }
  spawnSync("bash", ["-lc", `
    set -e
    if [ -f ${shell(root + "/.cotal/run/feedback.pid")} ]; then
      pid=$(cat ${shell(root + "/.cotal/run/feedback.pid")})
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
    fi
    if command -v ss >/dev/null 2>&1; then
      pids=$(ss -tlnp 2>/dev/null | awk '/:8787/ { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); $0=substr($0, RSTART+RLENGTH) } }' | sort -u)
      if [ -n "$pids" ]; then kill $pids >/dev/null 2>&1 || true; sleep 1; fi
    fi
    ${shell(startScript)}
  `], { stdio: "inherit" });
}

function shell(s) {
  return `'${String(s).replaceAll("'", `'"'"'`)}'`;
}

function listKeys() {
  const data = readKeys();
  if (!data.keys.length) {
    console.log("No feedback keys configured.");
    return;
  }
  for (const entry of data.keys) {
    console.log(`${entry.tester}${entry.name ? ` (${entry.name})` : ""}  ${masked(entry.key)}${entry.createdAt ? `  created=${entry.createdAt}` : ""}`);
  }
}

function addKey(tester, name) {
  if (!tester) throw new Error("add-key requires <tester>");
  const data = readKeys();
  const entry = { key: newKey(), tester, ...(name ? { name } : {}), createdAt: new Date().toISOString() };
  data.keys.push(entry);
  writeKeys(data);
  restart();
  console.log(`Created feedback key for ${tester}${name ? ` (${name})` : ""}:`);
  console.log(entry.key);
}

function revokeKey(target) {
  if (!target) throw new Error("revoke-key requires <tester-or-key>");
  const data = readKeys();
  const before = data.keys.length;
  data.keys = data.keys.filter((entry) => entry.tester !== target && entry.key !== target);
  const removed = before - data.keys.length;
  if (!removed) {
    console.log(`No matching key for ${target}.`);
    return;
  }
  writeKeys(data);
  restart();
  console.log(`Revoked ${removed} key${removed === 1 ? "" : "s"} for ${target}.`);
}

function rotateKey(tester, name) {
  if (!tester) throw new Error("rotate-key requires <tester>");
  const data = readKeys();
  data.keys = data.keys.filter((entry) => entry.tester !== tester);
  const entry = { key: newKey(), tester, ...(name ? { name } : {}), createdAt: new Date().toISOString() };
  data.keys.push(entry);
  writeKeys(data);
  restart();
  console.log(`Rotated feedback key for ${tester}${name ? ` (${name})` : ""}:`);
  console.log(entry.key);
}

function readFeedback() {
  if (!existsSync(feedbackPath)) return [];
  return readFileSync(feedbackPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return { id: `parse-error-${idx + 1}`, parseError: e.message, raw: line };
      }
    });
}

function pull(flags) {
  const limit = Number(flags.limit ?? 20);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
  let rows = readFeedback();
  if (flags.tester) rows = rows.filter((r) => r.tester?.tester === flags.tester);
  if (flags.origin) rows = rows.filter((r) => r.feedback?.origin === flags.origin);
  if (flags.type) rows = rows.filter((r) => r.feedback?.type === flags.type);
  rows = rows.slice(-limit);
  if (flags.json) {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  if (!rows.length) {
    console.log("No matching feedback.");
    return;
  }
  for (const row of rows) {
    const f = row.feedback ?? {};
    const who = row.tester?.name ? `${row.tester.tester} (${row.tester.name})` : row.tester?.tester ?? "unknown";
    console.log(`\n[${row.receivedAt ?? "?"}] ${row.id ?? "?"}  ${who}  origin=${f.origin ?? "?"}  type=${f.type ?? "?"}${f.severity ? `/${f.severity}` : ""}${f.area ? `  area=${f.area}` : ""}`);
    console.log(`Summary: ${f.summary ?? ""}`);
    if (f.details) console.log(`Details:\n${f.details}`);
    if (f.repro) console.log(`Repro:\n${f.repro}`);
    if (f.expected) console.log(`Expected:\n${f.expected}`);
    if (f.actual) console.log(`Actual:\n${f.actual}`);
  }
}

try {
  const { flags, positional } = parseFlags(args);
  switch (cmd) {
    case "list-keys":
      listKeys();
      break;
    case "add-key":
      addKey(positional[0], flags.name === true ? undefined : flags.name);
      break;
    case "revoke-key":
      revokeKey(positional[0]);
      break;
    case "rotate-key":
      rotateKey(positional[0], flags.name === true ? undefined : flags.name);
      break;
    case "pull":
      pull(flags);
      break;
    case "restart":
      restart();
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  console.error(`feedback-admin: ${e.message}`);
  process.exit(1);
}
