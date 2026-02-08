# @knaus94/prisma-extension-cache-manager

A caching extension for [Prisma](https://www.prisma.io/) with [@keyv/valkey](https://www.npmjs.com/package/@keyv/valkey).

## Features

- `@keyv/valkey` compatibility
- Only model queries can be cacheable (no $query or $queryRaw)
- Cache stampede protection:
  - Local in-flight deduplication (single process)
  - Distributed lock via Valkey/Redis (`SET NX PX`) for multi-instance apps

## Installation

Install:

```
npm i @knaus94/prisma-extension-cache-manager keyv @keyv/valkey
```

## Usage

```typescript
import { PrismaClient } from "@prisma/client";
import KeyvValkey from "@keyv/valkey";
import cacheExtension from "@knaus94/prisma-extension-cache-manager";

async function main() {
  const cache = new KeyvValkey("redis://localhost:6379");
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
