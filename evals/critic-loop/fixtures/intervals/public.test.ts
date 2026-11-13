import { expect, test } from "bun:test";
import { normalize, subtract } from "../src/subject";

test("normalizes overlapping and touching ranges", () => {
  expect(normalize([[5, 8], [1, 4], [4, 6]])).toEqual([[1, 8]]);
});

test("splits a range around an interior cut", () => {
  expect(subtract([[0, 10]], [[3, 7]])).toEqual([[0, 3], [7, 10]]);
});

test("leaves disjoint ranges intact", () => {
  expect(subtract([[0, 2], [5, 8]], [[2, 5]])).toEqual([[0, 2], [5, 8]]);
});
