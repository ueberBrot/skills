export const createCache = <V>(
  load: (key: string) => Promise<V>,
  now: () => number,
  ttlMs: number
) => {
  const values = new Map<string, { value: V; expiresAt: number }>();

  return {
    get(key: string): Promise<V> {
      const cached = values.get(key);
      if (cached !== undefined && now() < cached.expiresAt) {
        return Promise.resolve(cached.value);
      }
      const started = now();
      return load(key).then((value) => {
        values.set(key, { value, expiresAt: started + ttlMs });
        return value;
      });
    },
    invalidate(key: string): void {
      values.delete(key);
    },
  };
};
