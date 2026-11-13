import { expect, test } from "bun:test";
import { createCache } from "./reference";

test("coalesces by key while keys remain independent", async () => {
  const a = Promise.withResolvers<number>();
  const b = Promise.withResolvers<number>();
  const calls: string[] = [];
  const cache = createCache((key) => { calls.push(key); return key === "a" ? a.promise : b.promise; }, () => 0, 10);
  const first = cache.get("a");
  const same = cache.get("a");
  const other = cache.get("b");
  expect(first).toBe(same);
  expect(first).not.toBe(other);
  a.resolve(1); b.resolve(2);
  expect(await first).toBe(1);
  expect(await other).toBe(2);
  expect(calls.sort()).toEqual(["a", "b"]);
});

test("starts TTL at completion and expires exactly at its boundary", async () => {
  let time = 0;
  let calls = 0;
  const deferred = Promise.withResolvers<number>();
  const cache = createCache(() => { calls += 1; return calls === 1 ? deferred.promise : Promise.resolve(2); }, () => time, 10);
  const pending = cache.get("a");
  time = 100; deferred.resolve(1); await pending;
  time = 109; expect(await cache.get("a")).toBe(1);
  time = 110; expect(await cache.get("a")).toBe(2);
  expect(calls).toBe(2);
});

test("does not reuse a settled value with zero TTL", async () => {
  let calls = 0;
  const cache = createCache(async () => ++calls, () => 0, 0);
  expect(await cache.get("a")).toBe(1);
  expect(await cache.get("a")).toBe(2);
});

test("retries rejection without retaining a failed flight", async () => {
  let calls = 0;
  const cache = createCache(() => ++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(2), () => 0, 10);
  await expect(cache.get("a")).rejects.toThrow("offline");
  expect(await cache.get("a")).toBe(2);
});

test("turns a synchronous loader throw into a retryable rejection", async () => {
  let calls = 0;
  const cache = createCache(() => { if (++calls === 1) throw new Error("sync"); return Promise.resolve(2); }, () => 0, 10);
  let pending: Promise<number> | undefined;
  expect(() => { pending = cache.get("a"); }).not.toThrow();
  await expect(pending).rejects.toThrow("sync");
  expect(await cache.get("a")).toBe(2);
});

test("a stale success cannot overwrite fresh data", async () => {
  const old = Promise.withResolvers<number>();
  const fresh = Promise.withResolvers<number>();
  let calls = 0;
  const cache = createCache(() => ++calls === 1 ? old.promise : fresh.promise, () => 0, 10);
  const first = cache.get("a");
  await Promise.resolve();
  cache.invalidate("a");
  const second = cache.get("a");
  fresh.resolve(2); expect(await second).toBe(2);
  old.resolve(1); expect(await first).toBe(1);
  expect(await cache.get("a")).toBe(2);
  expect(calls).toBe(2);
});

test("a stale rejection cannot remove a newer pending registration", async () => {
  const old = Promise.withResolvers<number>();
  const fresh = Promise.withResolvers<number>();
  let calls = 0;
  const cache = createCache(() => ++calls === 1 ? old.promise : fresh.promise, () => 0, 10);
  const first = cache.get("a");
  const rejected = first.catch((error: unknown) => error);
  await Promise.resolve();
  cache.invalidate("a");
  const second = cache.get("a");
  old.reject(new Error("old"));
  expect(await rejected).toMatchObject({ message: "old" });
  expect(cache.get("a")).toBe(second);
  fresh.resolve(2); expect(await second).toBe(2);
  expect(calls).toBe(2);
});

test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid TTL %s", (ttl) => {
  expect(() => createCache(async () => 1, () => 0, ttl)).toThrow(RangeError);
});
