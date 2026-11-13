import { expect, test } from "bun:test";

import { retryDelay } from "../src/retry";

test("uses exponential backoff", () => {
  expect(retryDelay(0, 100, 5000)).toBe(100);
  expect(retryDelay(3, 100, 5000)).toBe(800);
});

test("caps the delay", () => {
  expect(retryDelay(10, 100, 5000)).toBe(5000);
});

test("rejects negative attempts", () => {
  expect(() => retryDelay(-1, 100, 5000)).toThrow(RangeError);
});
