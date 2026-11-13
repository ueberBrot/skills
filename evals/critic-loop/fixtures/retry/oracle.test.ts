import { expect, test } from "bun:test";

import { retryDelay } from "./reference";

test.each([
  [0, 125, 8000, 125],
  [4, 125, 8000, 2000],
  [8, 125, 8000, 8000],
  [0, 500, 50, 50],
  [1024, 1, 999, 999],
  [Number.MAX_SAFE_INTEGER, 1, 999, 999],
  [1024, 0, 999, 0],
  [Number.MAX_SAFE_INTEGER, 0, 999, 0],
  [1024, 125, 0, 0],
])("retryDelay(%s, %s, %s) returns %s", (attempt, base, cap, expected) => {
  expect(retryDelay(attempt, base, cap)).toBe(expected);
});

test.each([
  [-1, 100, 5000],
  [0.5, 100, 5000],
  [Number.MAX_SAFE_INTEGER + 1, 100, 5000],
  [0, -1, 5000],
  [0, 1.5, 5000],
  [0, Number.NaN, 5000],
  [0, Number.POSITIVE_INFINITY, 5000],
  [0, 100, -1],
  [0, 100, 1.5],
  [0, 100, Number.POSITIVE_INFINITY],
])("rejects invalid inputs %s, %s, %s", (attempt, base, cap) => {
  expect(() => retryDelay(attempt, base, cap)).toThrow(RangeError);
});
