/**
 * Incremental SSE frame parser: feed raw chunks as they arrive, get complete
 * frames out. Handles frames split across chunk boundaries, `id:`/`data:`/
 * `event:` fields, multi-line data, and comment heartbeats (lines starting
 * with `:`), which are surfaced so the consumer can reset its liveness timer.
 */

export type SSEFrame = {
  id?: string;
  event?: string;
  data: string;
};

export class SSEParser {
  private buffer = "";
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];

  /** Returns completed frames, and whether any heartbeat/activity was seen. */
  feed(chunk: string): { frames: SSEFrame[]; sawActivity: boolean } {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];
    let sawActivity = chunk.length > 0;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line === "") {
        if (this.data.length > 0) {
          frames.push({ id: this.id, event: this.event, data: this.data.join("\n") });
        }
        this.event = undefined;
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "id") this.id = value;
      else if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
    }

    return { frames, sawActivity };
  }

  get lastEventId(): string | undefined {
    return this.id;
  }
}
