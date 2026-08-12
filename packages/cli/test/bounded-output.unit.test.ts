import { describe, expect, it, vi } from "vitest";

import { writeBoundedOutput } from "../src/bounded-output.js";
import { CLI_LIMITS } from "../src/command-router.js";

describe("bounded CLI output", () => {
  it("preflights and emits large documents in ordered bounded chunks", async () => {
    const text = `${"a".repeat(CLI_LIMITS.maximumOutputChunkBytes)}😀${"b".repeat(128)}`;
    const chunks: string[] = [];

    await writeBoundedOutput(text, (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks.join("")).toBe(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1_048_576)).toBe(true);
    expect(chunks.every((chunk) => !/[\ud800-\udfff]$/u.test(chunk))).toBe(true);
  });

  it("rejects malformed Unicode and oversized documents before writing", async () => {
    const write = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(writeBoundedOutput("safe\ud800", write)).rejects.toBeInstanceOf(TypeError);
    await expect(
      writeBoundedOutput("x".repeat(CLI_LIMITS.maximumOutputBytes + 1), write),
    ).rejects.toBeInstanceOf(RangeError);
    expect(write).not.toHaveBeenCalled();
  });

  it("awaits sink backpressure and stops after a sink failure", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const failure = new Error("closed sink");
    const write = vi
      .fn<(chunk: string) => Promise<void>>()
      .mockImplementationOnce(() => firstPending)
      .mockRejectedValueOnce(failure);
    const operation = writeBoundedOutput("x".repeat(CLI_LIMITS.maximumOutputChunkBytes + 1), write);

    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await expect(operation).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
