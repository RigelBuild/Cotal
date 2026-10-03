import { fmtChannel, fmtFrom, type InboxItem } from "@cotal-ai/connector-core";
import { wrapped, type WrappedText } from "./wrap.js";
import type { CotalBatchDetails } from "./driver.js";

function heading(item: InboxItem): string {
  const from = fmtFrom(item);
  if (item.kind === "dm") return `Cotal · DM · ${from}`;
  if (item.kind === "anycast") return `Cotal · @${fmtChannel(item.service)} · ${from}`;
  return `Cotal · #${fmtChannel(item.channel)} · ${from}${item.mentionsMe ? " · @you" : ""}`;
}

export function renderCotalInbox(message: { content: unknown; details?: CotalBatchDetails }): WrappedText {
  const items = message.details?.items;
  if (!items?.length) return wrapped(typeof message.content === "string" ? message.content : "");
  const text = items.map((item) => `${heading(item)}\n  ${item.historical ? "(history) " : ""}${item.text.replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, "\n  ")}`).join("\n\n");
  return wrapped(text);
}
