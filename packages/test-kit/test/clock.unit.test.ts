import { describe, expect, test } from "vitest";

import { AdvancingClock, FixedClock } from "../src/clock.js";

describe("deterministic clocks", () => {
  test("a fixed clock implements the core clock contract without reading wall time", () => {
    const clock = new FixedClock(1_893_456_000_000);

    expect([clock.now(), clock.now(), clock.now()]).toEqual([
      1_893_456_000_000, 1_893_456_000_000, 1_893_456_000_000,
    ]);
  });

  test("an advancing clock moves by its configured step after each read", () => {
    const clock = new AdvancingClock(1_000, 25);

    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_025);
    expect(clock.peek()).toBe(1_050);
    clock.advanceBy(100);
    expect(clock.now()).toBe(1_150);
  });

  test("clock inputs reject nondeterministic numeric states", () => {
    expect(() => new FixedClock(Number.NaN)).toThrow(/safe integer/);
    expect(() => new AdvancingClock(0, -1)).toThrow(/must not be negative/);
    expect(() => new AdvancingClock(0, 0.5)).toThrow(/safe integer/);

    const advancing = new AdvancingClock(0);
    expect(() => {
      advancing.advanceBy(-1);
    }).toThrow(/must not be negative/);

    const clock = new AdvancingClock(Number.MAX_SAFE_INTEGER, 1);
    expect(() => clock.now()).toThrow(/advanced clock value must be a safe integer/);
  });
});
