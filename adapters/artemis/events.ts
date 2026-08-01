import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256File } from "../../src/core/evidence.ts";

export interface EventJournalSummary {
  path: string;
  count: number;
  bytes: number;
  sha256: string;
}

export class EventJournal {
  private count = 0;
  private bytes = 0;
  overflowed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly temporaryPath: string,
    private readonly finalPath: string,
    private readonly relativePath: string,
    private readonly maxCount: number,
    private readonly maxBytes: number,
  ) {}

  static async create(
    outputDirectory: string,
    relativePath: string,
    maxCount: number,
    maxBytes: number,
  ): Promise<EventJournal> {
    const finalPath = join(outputDirectory, relativePath);
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await mkdir(dirname(finalPath), { recursive: true });
    const handle = await open(temporaryPath, "wx");
    return new EventJournal(handle, temporaryPath, finalPath, relativePath, maxCount, maxBytes);
  }

  async append(event: unknown): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.count + 1 > this.maxCount) {
      this.overflowed = true;
      throw new Error(`Artemis event stream exceeds max_event_count (${this.maxCount})`);
    }
    if (this.bytes + bytes > this.maxBytes) {
      this.overflowed = true;
      throw new Error(`Artemis event stream exceeds max_event_bytes (${this.maxBytes})`);
    }
    await this.handle.writeFile(line, "utf8");
    this.count += 1;
    this.bytes += bytes;
  }

  async discard(): Promise<void> {
    await this.handle.close();
    await rm(this.temporaryPath, { force: true });
  }

  async finalize(): Promise<EventJournalSummary> {
    await this.handle.sync();
    await this.handle.close();
    await rename(this.temporaryPath, this.finalPath);
    return {
      path: this.relativePath,
      count: this.count,
      bytes: this.bytes,
      sha256: await sha256File(this.finalPath, this.bytes),
    };
  }
}
