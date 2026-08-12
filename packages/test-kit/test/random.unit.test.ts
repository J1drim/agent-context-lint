import { describe, expect, test, vi } from "vitest";

import { createSeededRandom, SEEDED_RANDOM_ALGORITHM, SeededRandom } from "../src/random.js";

describe("seeded random source", () => {
  test("replays the versioned Mulberry32 sequence for a known seed", () => {
    const random = createSeededRandom(0x1234_5678);

    expect(SEEDED_RANDOM_ALGORITHM).toBe("mulberry32-v1");
    expect(Array.from({ length: 6 }, () => random.nextUint32())).toEqual([
      455_919_406, 4_042_750_857, 4_036_713_555, 1_004_527_575, 3_885_174_651, 3_342_903_291,
    ]);
  });

  test("independent instances with the same seed have identical float and integer output", () => {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    const sample = (random: SeededRandom): readonly number[] => [
      random.nextFloat(),
      random.nextInteger(10),
      random.nextInteger(4_294_967_296),
      random.nextFloat(),
    ];
    expect(sample(first)).toEqual(sample(second));
    expect(first.seed).toBe(42);
    expect(first.algorithm).toBe(SEEDED_RANDOM_ALGORITHM);
  });

  test("rejects ambiguous seeds and invalid integer ranges", () => {
    expect(() => new SeededRandom(0.5)).toThrow(/seed must be a safe integer/);
    const random = new SeededRandom(0);
    expect(() => random.nextInteger(0)).toThrow(/1 through 2\^32/);
    expect(() => random.nextInteger(4_294_967_297)).toThrow(/1 through 2\^32/);
  });

  test("uses rejection sampling instead of modulo-biased integers", () => {
    const random = new SeededRandom(1);
    const nextUint32 = vi
      .spyOn(random, "nextUint32")
      .mockReturnValueOnce(4_294_967_295)
      .mockReturnValueOnce(5);

    expect(random.nextInteger(3)).toBe(2);
    expect(nextUint32).toHaveBeenCalledTimes(2);
  });
});
