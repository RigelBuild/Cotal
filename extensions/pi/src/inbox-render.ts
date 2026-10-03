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

export function renderCotalInbox(message: { content: unknown; details?: CotalBatchDetails }): WrappedText {
  const items = message.details?.items;
  if (!items?.length) return wrapped(typeof message.content === "string" ? message.content : "");
  return {
    invalidate(): void {},
    render(width: number): string[] {
      const lines: string[] = [];
      for (const item of items) {
        if (lines.length) lines.push("");
        lines.push(...wrapped(heading(item)).render(width));
        const body = `${item.historical ? "(history) " : ""}${item.text}`;
        for (const paragraph of body.split(/\r\n?|[\n\v\f\u0085\u2028\u2029]/)) {
          lines.push(...wrapped(paragraph).render(Math.max(1, width - 2)).map((line) => `  ${line}`));
        }
      }
      if (message.details?.suffix) lines.push("", ...wrapped(message.details.suffix).render(width));
      return lines;
    },
  };
}
