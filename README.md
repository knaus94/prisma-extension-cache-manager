# @knaus94/prisma-extension-cache-manager

A caching extension for [Prisma](https://www.prisma.io/) with [cache-manager](https://www.npmjs.com/package/cache-manager).

## Features

- `cache-manager` compatibility
- Only model queries can be cacheable (no $query or $queryRaw)
- Cache stampede protection:
  - Local in-flight deduplication (single process)
  - Distributed lock via Valkey/Redis (`SET NX PX`) for multi-instance apps

## Installation

Install:

```
npm i @knaus94/prisma-extension-cache-manager cache-manager
```

For Valkey/Redis store and distributed lock:

```
npm i keyv @keyv/valkey
```

## Usage

```typescript
import { PrismaClient } from "@prisma/client";
import { createCache } from "cache-manager";
import Keyv from "keyv";
import KeyvValkey from "@keyv/valkey";
import cacheExtension from "@knaus94/prisma-extension-cache-manager";

async function main() {
  const cache = createCache({
    stores: [new Keyv({ store: new KeyvValkey("redis://localhost:6379") })],
  });

  const prisma = new PrismaClient().$extends(
    cacheExtension({
      cache,
      lock: {
        ttl: 5000,
        waitTimeout: 2000,
        retryDelay: 40,
        retryJitter: 20,
        prefix: "prisma-cache-lock",
      },
    })
  );

  await prisma.user.findUniqueOrThrow({
    where: {
      email: user.email,
    },
    cache: true,
  });

  await prisma.user.findMany({
    cache: 5000,
  });

  await prisma.user.count({
    cache: {
      ttl: 2000,
      key: "user_count",
    },
  });

  await prisma.user.update({
    data: {},
    cache: {
      ttl: 2000,
      key: (result) => `user-${user.id}`,
    },
  });

  await prisma.user.create({
    data: {},
    uncache: `user_count`,
  });

  await prisma.user.create({
    data: {},
    cache: {
      ttl: 2000,
      key: (result) => `user-${user.id}`,
    },
    uncache: [`user_count`, `users`],
  });
}

main().catch(console.error);
```

For distributed lock, extension will use the first store with a Redis client at `cache.stores[*].store.redis`.
If lock is enabled and such store is not found, extension throws during initialization.

Disable distributed lock if needed:

```typescript
cacheExtension({
  cache,
  lock: false,
});
```

## Learn more

- [Docs — Client extensions](https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions)
- [Docs — Shared extensions](https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions/shared-extensions)
- [Preview announcement blog post](https://www.prisma.io/blog/client-extensions-preview-8t3w27xkrxxn#introduction)
