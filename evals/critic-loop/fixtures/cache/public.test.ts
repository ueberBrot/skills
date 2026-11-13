import { expect, test } from "bun:test";
import { createCache } from "../src/subject";

test("reuses a successful value before expiry", async () => {
  let calls = 0;
  const cache = createCache(async () => ++calls, () => 0, 10);
  expect(await cache.get("a")).toBe(1);
  expect(await cache.get("a")).toBe(1);
});

test("coalesces concurrent requests", async () => {
  let calls = 0;
  const cache = createCache(async () => ++calls, () => 0, 10);
  const first = cache.get("a");
  const second = cache.get("a");
  expect(first).toBe(second);
  expect(await first).toBe(1);
  expect(calls).toBe(1);
});

test("expires a settled value at the boundary", async () => {
  let time = 0;
  let calls = 0;
  const cache = createCache(async () => ++calls, () => time, 10);
  expect(await cache.get("a")).toBe(1);
  time = 10;
  expect(await cache.get("a")).toBe(2);
});
