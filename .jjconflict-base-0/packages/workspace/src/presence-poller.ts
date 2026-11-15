import type { CotalEndpoint, Presence } from "@cotal-ai/core";

export interface PresencePoller {
  start(): Promise<void>;
  read(): Promise<Presence[]>;
  stop(): void;
}

export function createPresencePoller(
  endpoint: CotalEndpoint,
  interval: number,
  onEvent: (event: { type: "join" | "update" | "offline"; presence: Presence }) => void,
  onError: (error: unknown) => void,
): PresencePoller {
  const seen = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let started = false;
  const read = async (): Promise<Presence[]> => {
    const rows = await endpoint.readPresence();
    if (stopped) return rows;
    for (const presence of rows) {
      const id = presence.card.id;
      const previous = seen.get(id);
      if (presence.status === "offline") {
        if (previous !== undefined) { seen.delete(id); onEvent({ type: "offline", presence }); }
      } else {
        const { ts: _ts, ...visible } = presence;
        const value = JSON.stringify(visible);
        seen.set(id, value);
        if (previous !== value) onEvent({ type: previous === undefined ? "join" : "update", presence });
      }
    }
    return rows;
  };
  return {
    read,
    async start() {
      if (started || stopped) return;
      started = true;
      try { await read(); } catch (error) { onError(error); }
      if (stopped) return;
      timer = setInterval(() => { void read().catch(onError); }, interval);
      timer.unref();
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}
