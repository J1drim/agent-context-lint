const UINT32_RANGE = 0x1_0000_0000;
const MULBERRY_INCREMENT = 0x6d2b_79f5;

/** Stable identifier for the seeded pseudo-random algorithm and output contract. */
export const SEEDED_RANDOM_ALGORITHM = "mulberry32-v1" as const;

/**
 * Reproducible Mulberry32 pseudo-random source.
 *
 * This implementation is for fixtures and replay only. It is not cryptographically secure.
 */
export class SeededRandom {
  readonly algorithm: typeof SEEDED_RANDOM_ALGORITHM = SEEDED_RANDOM_ALGORITHM;
  readonly seed: number;
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError("seed must be a safe integer");
    }
    this.seed = seed >>> 0;
    this.#state = this.seed;
  }

  nextUint32(): number {
    this.#state = (this.#state + MULBERRY_INCREMENT) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  nextInteger(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
      throw new RangeError("maxExclusive must be a safe integer from 1 through 2^32");
    }
    const acceptedRange = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
    let value = this.nextUint32();
    while (value >= acceptedRange) {
      value = this.nextUint32();
    }
    return value % maxExclusive;
  }
}

export function createSeededRandom(seed: number): SeededRandom {
  return new SeededRandom(seed);
}
