import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { hash } from "object-code";
import { Prisma } from "@prisma/client/extension";

/* helpers -------------------------------------------------------------- */
const hashKey = (m: string, a: any) => `${m}@${hash(a)}`;
const ns = (k: string, n?: string) => (n ? `${n}:${k}` : k);
const WRITE_OPS = new Set([
  "create",
  "createMany",
  "updateMany",
  "upsert",
  "update",
]);

const toUncache = (opt: any, res: any): string[] =>
  !opt
    ? []
    : typeof opt === "function"
      ? Array(opt(res))
      : typeof opt === "string"
        ? [opt]
        : opt.map((o: any) =>
            typeof o === "string" ? o : ns(o.key, o.namespace)
          );

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

          const finish = async (res: any) => {
            const dels = toUncache(uncache, res);
            if (dels.length) cache.mdel(dels).catch(() => {});
            return res;
          };

          if (cOpt === undefined) return finish(await query(queryArgs));

          /* key + ttl */
          let key: string;
          let ttl: number | undefined;

          if (typeof cOpt !== "object" || Array.isArray(cOpt)) {
            key = typeof cOpt === "string" ? cOpt : hashKey(model, queryArgs);
            if (typeof cOpt === "number") ttl = cOpt;
          } else if (typeof cOpt.key === "function") {
            const res = await query(queryArgs);
            await finish(res);

            key = cOpt.key(res);
            ttl = cOpt.ttl; // как есть
            try {
              await cache.set(key, res, ttl);
            } catch {}
            return res;
          } else {
            key = ns(cOpt.key ?? hashKey(model, queryArgs), cOpt.namespace);
            ttl = cOpt.ttl;
          }

          /* try cache for reads */
          if (!WRITE_OPS.has(operation)) {
            try {
              const hit = await cache.get(key);
              if (hit != null) return hit;
            } catch {}
          }

          /* DB round-trip */
          const res = await query(queryArgs);
          await finish(res);
          try {
            await cache.set(key, res, ttl);
          } catch {}
          return res;
        },
      },
    },
  });
