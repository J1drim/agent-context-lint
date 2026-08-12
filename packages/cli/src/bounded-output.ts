import { CLI_LIMITS } from "./command-router.js";

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function scalarByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Preflight and emit a complete CLI document without exceeding the router's per-write bound.
 *
 * Validation and chunk-boundary construction finish before the first write. Writes are awaited
 * serially so the router remains the single authority for cancellation, aggregate limits, and
 * sink backpressure.
 */
export async function writeBoundedOutput(
  text: string,
  write: (chunk: string) => Promise<void> | void,
): Promise<void> {
  const boundaries: number[] = [0];
  let chunkBytes = 0;
  let totalBytes = 0;
  let index = 0;

  while (index < text.length) {
    const first = text.charCodeAt(index);
    let codePoint = first;
    let width = 1;
    if (first >= HIGH_SURROGATE_START && first <= HIGH_SURROGATE_END) {
      const second = text.charCodeAt(index + 1);
      if (!Number.isFinite(second) || second < LOW_SURROGATE_START || second > LOW_SURROGATE_END)
        throw new TypeError("CLI output contains an unpaired surrogate");
      codePoint = 0x1_0000 + ((first - HIGH_SURROGATE_START) << 10) + second - LOW_SURROGATE_START;
      width = 2;
    } else if (first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END) {
      throw new TypeError("CLI output contains an unpaired surrogate");
    }

    const bytes = scalarByteLength(codePoint);
    if (chunkBytes + bytes > CLI_LIMITS.maximumOutputChunkBytes) {
      boundaries.push(index);
      chunkBytes = 0;
    }
    chunkBytes += bytes;
    totalBytes += bytes;
    if (totalBytes > CLI_LIMITS.maximumOutputBytes)
      throw new RangeError("CLI output exceeds the aggregate byte limit");
    index += width;
  }
  boundaries.push(text.length);

  for (let boundary = 0; boundary + 1 < boundaries.length; boundary += 1) {
    const start = boundaries[boundary];
    const end = boundaries[boundary + 1];
    if (start === undefined || end === undefined || start === end) continue;
    await write(text.slice(start, end));
  }
}
