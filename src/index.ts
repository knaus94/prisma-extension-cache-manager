import { hash } from "object-code";
import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { Prisma } from "@prisma/client/extension";
import type KeyvValkey from "@keyv/valkey";

/* helpers -------------------------------------------------------------- */
const composedKey = (m: string, a: any) => `${m}@${hash(a)}`;

const ns = (k: string, n?: string) => (n ? `${n}:${k}` : k);

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "updateMany",
  "upsert",
  "update",
  "delete",
]);
const CACHE_OPERATION_SET = new Set(CACHE_OPERATIONS as readonly string[]);
const isWrite = (op: string) => WRITE_OPERATIONS.has(op);

/* uncache → массив строк */
const toUncache = (opt: any, res: any): string[] => {
  if (!opt) return [];

  const values = typeof opt === "function" ? opt(res) : opt;
  const list = Array.isArray(values) ? values : [values];

  return list
    .map((entry: any) =>
      typeof entry === "string" ? entry : entry?.key ? ns(entry.key, entry.namespace) : undefined
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

const deleteMany = async (cache: KeyvValkey, keys: string[]) => {
  if (!keys.length) return;
  if (typeof cache.deleteMany === "function") {
    await cache.deleteMany(keys);
    return;
  }

  await Promise.all(keys.map((key) => cache.delete(key)));
};

const processUncache = async (cache: KeyvValkey, opt: any, res: any) => {
  const keys = toUncache(opt, res);
  await deleteMany(cache, keys).catch(() => {});
};

const isCacheHit = (value: unknown) => value !== undefined;
const safeGet = async (cache: KeyvValkey, key: string) =>
  cache.get(key).catch(() => undefined);
const safeSet = async (cache: KeyvValkey, key: string, value: unknown, ttl?: number) =>
  cache.set(key, value, ttl).catch(() => {});

type RedisLockClient = {
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

const resolveRedisLockClient = (cache: KeyvValkey): RedisLockClient | undefined => {
  const redis = cache.redis as unknown;
  if (!redis || typeof redis !== "object") return undefined;

  const candidate = redis as { set?: unknown; eval?: unknown };
  return typeof candidate.set === "function" && typeof candidate.eval === "function"
    ? (redis as RedisLockClient)
    : undefined;
};

type LockOptions = {
  enabled: boolean;
  prefix: string;
  ttl: number;
  waitTimeout: number;
  retryDelay: number;
  retryJitter: number;
};

const DEFAULT_LOCK_OPTIONS: LockOptions = {
  enabled: true,
  prefix: "prisma-cache-lock",
  ttl: 5000,
  waitTimeout: 2000,
  retryDelay: 40,
  retryJitter: 20,
};

const LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

const toPositive = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const resolveLockOptions = (
  lock: PrismaRedisCacheConfig["lock"]
): LockOptions => {
  if (lock === false) return { ...DEFAULT_LOCK_OPTIONS, enabled: false };
  if (!lock) return { ...DEFAULT_LOCK_OPTIONS };

  const prefix =
    typeof lock.prefix === "string" && lock.prefix.trim().length
      ? lock.prefix
      : DEFAULT_LOCK_OPTIONS.prefix;

  return {
    enabled: lock.enabled ?? DEFAULT_LOCK_OPTIONS.enabled,
    prefix,
    ttl: toPositive(lock.ttl, DEFAULT_LOCK_OPTIONS.ttl),
    waitTimeout: toPositive(lock.waitTimeout, DEFAULT_LOCK_OPTIONS.waitTimeout),
    retryDelay: toPositive(lock.retryDelay, DEFAULT_LOCK_OPTIONS.retryDelay),
    retryJitter: toPositive(lock.retryJitter, DEFAULT_LOCK_OPTIONS.retryJitter),
  };
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const createLockToken = () =>
  `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

const tryAcquireLock = async (
  redis: RedisLockClient,
  key: string,
  token: string,
  ttl: number
): Promise<boolean> => {
  const result = await redis.set(key, token, "PX", ttl, "NX").catch(() => undefined);
  return result === "OK" || result === true;
};

const releaseLock = async (
  redis: RedisLockClient,
  key: string,
  token: string
) => {
  await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token).catch(() => {});
};

const waitForCacheFill = async (
  cache: KeyvValkey,
  key: string,
  options: LockOptions
) => {
  const deadline = Date.now() + options.waitTimeout;
  while (Date.now() < deadline) {
    const jitter = Math.floor(Math.random() * (options.retryJitter + 1));
    await sleep(options.retryDelay + jitter);

    const hit = await safeGet(cache, key);
    if (isCacheHit(hit)) return hit;
  }
  return undefined;
};

const hasResultKeyFactory = (
  cOpt: any
): cOpt is {
  key: (result: any) => string;
  ttl?: number;
} =>
  !!cOpt &&
  typeof cOpt === "object" &&
  !Array.isArray(cOpt) &&
  typeof cOpt.key === "function";

const resolveStaticCacheConfig = (model: string, cOpt: any, queryArgs: any) => {
  if (typeof cOpt === "string") return { key: cOpt, ttl: undefined as number | undefined };
  if (typeof cOpt === "number") return { key: composedKey(model, queryArgs), ttl: cOpt };

  if (cOpt && typeof cOpt === "object" && !Array.isArray(cOpt)) {
    return {
      key: ns(cOpt.key ?? composedKey(model, queryArgs), cOpt.namespace),
      ttl: cOpt.ttl ?? undefined,
    };
  }

  return { key: composedKey(model, queryArgs), ttl: undefined as number | undefined };
};

/* extension ------------------------------------------------------------ */
export default ({ cache, lock }: PrismaRedisCacheConfig) => {
  const inflight = new Map<string, Promise<unknown>>();
  const lockOptions = resolveLockOptions(lock);
  const redis = resolveRedisLockClient(cache);

  const runSingleFlight = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const task = (async () => {
      try {
        return await fn();
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
  };

  const executeQuery = async (query: any, queryArgs: any, uncache: any) => {
    const db = await query(queryArgs);
    await processUncache(cache, uncache, db);
    return db;
  };

  const executeQueryAndCache = async (
    key: string,
    ttl: number | undefined,
    query: any,
    queryArgs: any,
    uncache: any
  ) => {
    const db = await executeQuery(query, queryArgs, uncache);
    await safeSet(cache, key, db, ttl);
    return db;
  };

  return Prisma.defineExtension({
    name: "prisma-extension-cache-manager",
    client: { $cache: cache },
    model: { $allModels: {} as ModelExtension },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!CACHE_OPERATION_SET.has(operation)) return query(args);

          const operationArgs = (args ?? {}) as any;
          const { cache: cOpt, uncache, ...queryArgs } = operationArgs;

          if (cOpt === undefined || cOpt === false) {
            return executeQuery(query, queryArgs, uncache);
          }

          if (hasResultKeyFactory(cOpt)) {
            const db = await executeQuery(query, queryArgs, uncache);
            await safeSet(cache, cOpt.key(db), db, cOpt.ttl ?? undefined);
            return db;
          }

          const { key, ttl } = resolveStaticCacheConfig(model, cOpt, queryArgs);
          if (isWrite(operation)) {
            return executeQueryAndCache(key, ttl, query, queryArgs, uncache);
          }

          const hit = await safeGet(cache, key);
          if (isCacheHit(hit)) return hit;

          return runSingleFlight(key, async () => {
            const secondHit = await safeGet(cache, key);
            if (isCacheHit(secondHit)) return secondHit;

            if (!lockOptions.enabled || !redis) {
              return executeQueryAndCache(key, ttl, query, queryArgs, uncache);
            }

            const lockKey = `${lockOptions.prefix}:${key}`;
            const token = createLockToken();
            const acquired = await tryAcquireLock(redis, lockKey, token, lockOptions.ttl);

            if (acquired) {
              try {
                const lockedHit = await safeGet(cache, key);
                if (isCacheHit(lockedHit)) return lockedHit;

                return executeQueryAndCache(key, ttl, query, queryArgs, uncache);
              } finally {
                await releaseLock(redis, lockKey, token);
              }
            }

            const waitedHit = await waitForCacheFill(cache, key, lockOptions);
            if (isCacheHit(waitedHit)) return waitedHit;

            return executeQueryAndCache(key, ttl, query, queryArgs, uncache);
          });
        },
      },
    },
  });
};
