import { expect, test } from "bun:test";
import { normalize, subtract } from "./reference";

test.each([
  { source: [[5, 8], [1, 4], [4, 6]], expected: [[1, 8]] },
  { source: [[-8, -3], [-4, 2], [2, 2], [-8, -3]], expected: [[-8, 2]] },
  { source: [[0, 10], [2, 3], [4, 6]], expected: [[0, 10]] },
  { source: [], expected: [] },
])("normalizes a union without zero-length spans", ({ source, expected }) => {
  expect(normalize(source as [number, number][])).toEqual(expected);
});

test.each([
  { source: [[0, 10]], removed: [[3, 7]], expected: [[0, 3], [7, 10]] },
  { source: [[0, 10]], removed: [[6, 9], [2, 4], [4, 7]], expected: [[0, 2], [9, 10]] },
  { source: [[0, 4], [3, 10]], removed: [[-2, 2], [8, 12]], expected: [[2, 8]] },
  { source: [[-10, -2], [0, 5]], removed: [[-6, 2]], expected: [[-10, -6], [2, 5]] },
  { source: [[0, 2], [5, 8]], removed: [[2, 5]], expected: [[0, 2], [5, 8]] },
  { source: [[0, 10]], removed: [[0, 10]], expected: [] },
  { source: [], removed: [[1, 2]], expected: [] },
])("subtracts normalized half-open sets", ({ source, removed, expected }) => {
  expect(subtract(source as [number, number][], removed as [number, number][])).toEqual(expected);
});

test("does not mutate or alias caller-owned tuples", () => {
  const source = Object.freeze([Object.freeze([3, 6] as const), Object.freeze([1, 4] as const)]);
  const removed = Object.freeze([Object.freeze([2, 5] as const)]);
  const normalized = normalize(source);
  const difference = subtract(source, removed);
  normalized[0][0] = -100; difference[0][0] = -100;
  expect(source).toEqual([[3, 6], [1, 4]]);
  expect(removed).toEqual([[2, 5]]);
});

test.each([[2, 1], [0.5, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1]])("rejects invalid endpoints", (start, end) => {
  expect(() => normalize([[start, end]])).toThrow(RangeError);
  expect(() => subtract([[start, end]], [])).toThrow(RangeError);
  expect(() => subtract([], [[start, end]])).toThrow(RangeError);
});

test("matches independent integer-cell membership for overlapping sets", () => {
  for (let a = -3; a <= 1; a += 1) {
    for (let b = a + 1; b <= 3; b += 1) {
      const source: [number, number][] = [[a, b], [-1, 2]];
      const removed: [number, number][] = [[-2, 0], [1, 2]];
      const result = subtract(source, removed);
      for (let point = -4; point < 4; point += 1) {
        const contains = (ranges: readonly (readonly [number, number])[]) => ranges.some(([start, end]) => start <= point && point < end);
        expect(contains(result)).toBe(contains(source) && !contains(removed));
      }
      expect(result).toEqual(normalize(result));
    }
  }
});
