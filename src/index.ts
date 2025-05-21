import { hash } from "object-code";
import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { Prisma } from "@prisma/client/extension";

/* helpers -------------------------------------------------------------- */
const composedKey = (m: string, a: any) => `${m}@${hash(a)}`;

const ns = (k: string, n?: string) => (n ? `${n}:${k}` : k);

const isWrite = (op: string) =>
  ["create", "createMany", "updateMany", "upsert", "update"].includes(op);

/* uncache → массив строк */
const toUncache = (opt: any, res: any): string[] =>
  !opt
    ? []
    : typeof opt === "function"
      ? ([] as string[]).concat(opt(res))
      : typeof opt === "string"
        ? [opt]
        : opt.map((o: any) =>
            typeof o === "string" ? o : ns(o.key, o.namespace)
          );

const processUncache = async (cache: any, opt: any, res: any) => {
  const keys = toUncache(opt, res);
  if (keys.length) await cache.mdel(keys).catch(() => {});
};

/* extension ------------------------------------------------------------ */
export default ({ cache }: PrismaRedisCacheConfig) =>
  Prisma.defineExtension({
    name: "prisma-extension-cache-manager",
    client: { $cache: cache },
    model: { $allModels: {} as ModelExtension },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!(CACHE_OPERATIONS as readonly string[]).includes(operation))
            return query(args);

          const { cache: cOpt, uncache, ...queryArgs } = args as any;

          if (cOpt === undefined) {
            const db = await query(queryArgs);
            await processUncache(cache, uncache, db);
            return db;
          }

          let key: string;
          let ttl: number | undefined;

          if (typeof cOpt !== "object" || Array.isArray(cOpt)) {
            key =
              typeof cOpt === "string" ? cOpt : composedKey(model, queryArgs);
            if (typeof cOpt === "number") ttl = cOpt;
          } else if (typeof cOpt.key === "function") {
            const db = await query(queryArgs);
            await processUncache(cache, uncache, db);

            key = cOpt.key(db);
            ttl = cOpt.ttl ?? undefined;

            await cache.set(key, db, ttl);
            return db;
          } else {
            key = ns(cOpt.key ?? composedKey(model, queryArgs), cOpt.namespace);
            ttl = cOpt.ttl ?? undefined;
          }

          if (!isWrite(operation)) {
            const hit = await cache.get(key).catch(() => undefined);
            if (hit !== undefined && hit !== null) return hit;
          }

          const db = await query(queryArgs);
          await processUncache(cache, uncache, db);

          await cache.set(key, db, ttl);
          return db;
        },
      },
    },
  });
