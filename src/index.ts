import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { createHash } from "crypto";
import { Prisma } from "@prisma/client/extension";

/**
 * Produce a stable cache key from model name and query arguments.
 */
function generateComposedKey(options: {
  model: string;
  queryArgs: any;
}): string {
  const hash = createHash("md5")
    .update(JSON.stringify(options.queryArgs))
    .digest("hex");
  return `${options.model}@${hash}`;
}

/**
 * Prefix the key with a namespace (if present).
 */
function createKey(key: string, namespace?: string): string {
  return namespace ? `${namespace}:${key}` : key;
}

/**
 * Delete keys from cache after a write operation.
 */
async function processUncache(
  cache: any,
  uncacheOption: any,
  result: any
): Promise<boolean> {
  let keysToDelete: string[] = [];

  if (typeof uncacheOption === "function") {
    const keys = uncacheOption(result);
    keysToDelete = Array.isArray(keys) ? keys : [keys];
  } else if (typeof uncacheOption === "string") {
    keysToDelete = [uncacheOption];
  } else if (Array.isArray(uncacheOption)) {
    if (typeof uncacheOption[0] === "string") {
      keysToDelete = uncacheOption;
    } else if (typeof uncacheOption[0] === "object") {
      keysToDelete = uncacheOption.map((obj: any) =>
        obj.namespace ? `${obj.namespace}:${obj.key}` : obj.key
      );
    }
  }

  if (keysToDelete.length === 0) return true;

  try {
    await cache.mdel(keysToDelete);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether cache option is valid.
 */
const shouldUseCache = (opt: any) =>
  opt !== undefined &&
  ["boolean", "object", "number", "string"].includes(typeof opt);

/**
 * Decide whether uncache option is valid.
 */
const shouldUseUncache = (opt: any) =>
  opt !== undefined &&
  (typeof opt === "function" || typeof opt === "string" || Array.isArray(opt));

/**
 * Prisma extension that adds transparent Redis caching.
 */
export default ({ cache, debug, ttl: defaultTTL }: PrismaRedisCacheConfig) =>
  Prisma.defineExtension({
    name: "prisma-extension-cache-manager",
    client: {
      $cache: cache,
    },
    model: {
      $allModels: {} as ModelExtension,
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!(CACHE_OPERATIONS as unknown as string[]).includes(operation)) {
            return query(args);
          }

          const isWriteOp = [
            "create",
            "createMany",
            "updateMany",
            "upsert",
            "update",
          ].includes(operation);

          const {
            cache: cacheOption,
            uncache: uncacheOption,
            ...queryArgs
          } = args as any;

          const useCache = shouldUseCache(cacheOption);
          const useUncache = shouldUseUncache(uncacheOption);

          // --- No cache requested -----------------------------------------
          if (!useCache) {
            const res = await query(queryArgs);
            if (useUncache) await processUncache(cache, uncacheOption, res);
            return res;
          }

          // --- Build key & ttl --------------------------------------------
          let cacheKey: string;
          let ttl: number | undefined;

          if (["boolean", "number", "string"].includes(typeof cacheOption)) {
            cacheKey =
              typeof cacheOption === "string"
                ? cacheOption
                : generateComposedKey({ model, queryArgs });

            ttl = typeof cacheOption === "number" ? cacheOption : undefined;
          } else if (typeof cacheOption.key === "function") {
            // Key depends on DB result – run query first
            const res = await query(queryArgs);
            if (useUncache) await processUncache(cache, uncacheOption, res);

            cacheKey = cacheOption.key(res);
            ttl = cacheOption.ttl ?? defaultTTL;

            if (ttl && ttl > 0) {
              await cache.set(cacheKey, res, Math.ceil(ttl / 1000));
            } else {
              await cache.set(cacheKey, res);
            }
            if (debug) console.log("Data cached (fn key):", cacheKey);
            return res;
          } else {
            cacheKey =
              createKey(cacheOption.key, cacheOption.namespace) ||
              generateComposedKey({ model, queryArgs });
            ttl = cacheOption.ttl;
          }

          // --- Try cache for read ops -------------------------------------
          if (!isWriteOp) {
            try {
              const cached = await cache.get(cacheKey);
              if (cached !== undefined && cached !== null) {
                if (debug) console.log("Cache hit:", cacheKey);
                return cached;
              }
              if (debug) console.log("Cache miss:", cacheKey);
            } catch (e) {
              if (debug) console.error("Cache get failed", e);
            }
          }

          // --- Fallback to DB ---------------------------------------------
          const res = await query(queryArgs);

          if (useUncache) await processUncache(cache, uncacheOption, res);

          ttl = ttl ?? defaultTTL;
          try {
            if (ttl && ttl > 0) {
              await cache.set(cacheKey, res, Math.ceil(ttl / 1000));
            } else {
              await cache.set(cacheKey, res);
            }
            if (debug) console.log("Data cached:", cacheKey);
          } catch (e) {
            if (debug) console.error("Cache set failed", e);
          }

          return res;
        },
      },
    },
  });
