function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

/** A clock whose epoch-millisecond value never changes. */
export class FixedClock {
  readonly #milliseconds: number;

  constructor(milliseconds: number) {
    requireSafeInteger(milliseconds, "milliseconds");
    this.#milliseconds = milliseconds;
  }

  now(): number {
    return this.#milliseconds;
  }
}

/** A clock that advances by a fixed number of milliseconds after every read. */
export class AdvancingClock {
  #milliseconds: number;
  readonly #stepMilliseconds: number;

  constructor(milliseconds: number, stepMilliseconds = 1) {
    requireSafeInteger(milliseconds, "milliseconds");
    requireSafeInteger(stepMilliseconds, "stepMilliseconds");
    if (stepMilliseconds < 0) {
      throw new RangeError("stepMilliseconds must not be negative");
    }
    this.#milliseconds = milliseconds;
    this.#stepMilliseconds = stepMilliseconds;
  }

  now(): number {
    const current = this.#milliseconds;
    this.advanceBy(this.#stepMilliseconds);
    return current;
  }

  peek(): number {
    return this.#milliseconds;
  }

  advanceBy(milliseconds: number): void {
    requireSafeInteger(milliseconds, "milliseconds");
    if (milliseconds < 0) {
      throw new RangeError("milliseconds must not be negative");
    }
    const next = this.#milliseconds + milliseconds;
    requireSafeInteger(next, "advanced clock value");
    this.#milliseconds = next;
  }
}
