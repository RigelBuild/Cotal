import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ZellijPlacement } from "./driver.js";

export type AgentPlacement = ZellijPlacement;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SHAPE_KEYS: Record<string, true> = { stacked: true, floating: true, direction: true };

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseZellijPlacement(source: string): AgentPlacement | undefined {
  const match = FRONTMATTER.exec(source);
  if (!match) {
    if (source.startsWith("---")) throw new Error("zellij placement: malformed frontmatter fence");
    return undefined;
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`zellij placement: invalid YAML frontmatter: ${reason}`);
  }
  if (frontmatter === null || frontmatter === undefined) return undefined;
  if (!isMapping(frontmatter)) throw new Error("zellij placement: frontmatter must be a mapping");
  if (!Object.hasOwn(frontmatter, "zellij")) return undefined;
  const rawPlacement = frontmatter.zellij;
  if (!isMapping(rawPlacement)) throw new Error("zellij placement: zellij must be a mapping");

  const keys = Object.keys(rawPlacement);
  if (keys.length === 0) throw new Error("zellij placement: zellij block must not be empty");
  for (const key of keys) {
    if (key !== "tab" && SHAPE_KEYS[key] !== true)
      throw new Error(`zellij placement: unknown key ${JSON.stringify(key)}`);
  }
  const shapes = keys.filter((key) => SHAPE_KEYS[key] === true);
  if (shapes.length > 1) throw new Error("zellij placement: at most one pane shape may be specified");

  const rawTab = rawPlacement.tab;
  let tab: string | undefined;
  if (rawTab !== undefined) {
    if (typeof rawTab !== "string" || rawTab.trim().length === 0)
      throw new Error("zellij placement: tab must be a non-empty string");
    if (rawTab.trim().startsWith("-")) throw new Error("zellij placement: tab name must not start with '-'");
    tab = rawTab;
  }

  const shape = shapes[0];
  if (shape === "stacked" || shape === "floating") {
    if (typeof rawPlacement[shape] !== "boolean")
      throw new Error(`zellij placement: ${shape} must be a boolean`);
    return { ...(tab === undefined ? {} : { tab }), [shape]: rawPlacement[shape] };
  }
  if (shape === "direction") {
    const direction = rawPlacement.direction;
    if (direction !== "right" && direction !== "down")
      throw new Error('zellij placement: direction must be "right" or "down"');
    return { ...(tab === undefined ? {} : { tab }), direction };
  }
  return { ...(tab === undefined ? {} : { tab }), ...(tab === undefined ? {} : { stacked: true }) };
}

export function readZellijPlacement(agentFile: string | undefined): AgentPlacement | undefined {
  if (!agentFile) return undefined;
  let source: string;
  try {
    source = readFileSync(agentFile, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`zellij placement: cannot read agent file ${JSON.stringify(agentFile)}: ${reason}`);
  }
  return parseZellijPlacement(source);
}
