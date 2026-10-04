import { fmtChannel, fmtFrom, type InboxItem } from "@cotal-ai/connector-core";
import { wrapped, type WrappedText } from "./wrap.js";
import type { CotalBatchDetails } from "./driver.js";

function heading(item: InboxItem): string {
  const safe = (value: string): string => value.replace(/·/g, "∙");
  const from = safe(fmtFrom(item));
  if (item.kind === "dm") return `Cotal · DM · [${from}]`;
  if (item.kind === "anycast") return `Cotal · @${safe(fmtChannel(item.service))} · [${from}]`;
  return `Cotal · #${safe(fmtChannel(item.channel))} · [${from}]${item.mentionsMe ? " · @you" : ""}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function validItem(item: unknown): item is InboxItem {
  if (!item || typeof item !== "object") return false;
  if (!("kind" in item && "text" in item && "fromName" in item)) return false;
  if (item.kind !== "dm" && item.kind !== "channel" && item.kind !== "anycast") return false;
  if (typeof item.text !== "string" || typeof item.fromName !== "string") return false;
  if ("fromRole" in item && item.fromRole !== undefined && typeof item.fromRole !== "string") return false;
  if (item.kind === "channel" && (!("channel" in item) || typeof item.channel !== "string")) return false;
  if (item.kind === "anycast" && (!("service" in item) || typeof item.service !== "string")) return false;
  return true;
}

export function renderCotalInbox(message: { content: unknown; details?: CotalBatchDetails }): WrappedText {
  const items = message.details?.items;
  if (!Array.isArray(items) || !items.length || !items.every(validItem)) return wrapped(contentText(message.content));
  return {
    invalidate(): void {},
    render(width: number): string[] {
      const lines: string[] = [];
      for (const item of items) {
        if (lines.length) lines.push("");
        lines.push(...wrapped(heading(item)).render(width));
        const body = `${item.historical ? "(history) " : ""}${item.text}`;
        const indent = width > 3 ? "  " : "";
        for (const paragraph of body.split(/\r\n?|[\n\v\f\u0085\u2028\u2029]/)) {
          lines.push(...wrapped(paragraph).render(Math.max(1, width - indent.length)).map((line) => `${indent}${line}`));
        }
      }
      if (message.details?.suffix) lines.push("", ...wrapped(message.details.suffix).render(width));
      return lines;
    },
  };
}
