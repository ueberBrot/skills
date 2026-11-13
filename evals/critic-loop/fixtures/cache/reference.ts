export const createCache = <V>(
  load: (key: string) => Promise<V>,
  now: () => number,
  ttlMs: number
) => {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new RangeError("Invalid TTL");
  }
  const values = new Map<string, { value: V; expiresAt: number }>();
  const flights = new Map<string, { token: symbol; promise: Promise<V> }>();
  return {
    get(key: string): Promise<V> {
      const cached = values.get(key);
      if (cached !== undefined && now() < cached.expiresAt) {
        return Promise.resolve(cached.value);
      }
      const active = flights.get(key);
      if (active !== undefined) {
        return active.promise;
      }
      const token = Symbol(key);
      const promise = Promise.resolve()
        .then(() => load(key))
        .then((value) => {
          if (flights.get(key)?.token === token) {
            values.set(key, { value, expiresAt: now() + ttlMs });
          }
          return value;
        })
        .finally(() => {
          if (flights.get(key)?.token === token) {
            flights.delete(key);
          }
        });
      flights.set(key, { token, promise });
      return promise;
    },
    invalidate(key: string): void {
      values.delete(key);
      flights.delete(key);
    },
  };
};
