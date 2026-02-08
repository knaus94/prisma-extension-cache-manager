export type Cache = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T, ttl?: number) => Promise<T>;
  mdel: (keys: string[]) => Promise<boolean>;
  stores: Array<{ store?: unknown }>;
};
