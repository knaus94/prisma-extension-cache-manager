import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { createHash } from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client/extension";
import msgpack from "msgpack5";

/**
 * Генерирует уникальный ключ для кеширования на основе модели и аргументов запроса.
 * @param options - Опции для генерации ключа.
 * @returns Сгенерированный ключ.
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
 * Создаёт ключ с опциональным пространством имен.
 * @param key - Основной ключ.
 * @param namespace - Пространство имен.
 * @returns Полный ключ с пространством имен, если оно указано.
 */
function createKey(key: string, namespace?: string): string {
  return namespace ? `${namespace}:${key}` : key;
}

// Универсальная функция для сериализации данных
function serializeData(data) {
  if (data instanceof Date) {
    return { __type: "Date", value: data.toISOString() };
  } else if (data instanceof Decimal) {
    return { __type: "Decimal", value: data.toString() };
  } else if (Array.isArray(data)) {
    return data.map(serializeData); // Рекурсивно обрабатываем массивы
  } else if (data !== null && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, serializeData(value)])
    );
  }
  return data; // Простые значения возвращаем как есть
}

// Универсальная функция для десериализации данных
function deserializeData(data) {
  if (data && data.__type === "Date") {
    return new Date(data.value);
  } else if (data && data.__type === "Decimal") {
    return new Decimal(data.value);
  } else if (Array.isArray(data)) {
    return data.map(deserializeData); // Рекурсивно обрабатываем массивы
  } else if (data !== null && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, deserializeData(value)])
    );
  }
  return data; // Простые значения возвращаем как есть
}

/**
 * Обрабатывает удаление ключей из кеша после операций записи.
 * @param cache - Кеш-менеджер.
 * @param uncacheOption - Опции удаления кеша.
 * @param result - Результат операции.
 * @returns Promise<boolean> указывающий на успешность удаления.
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
    await cache.store.mdel(...keysToDelete);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Определяет, следует ли использовать кеширование для текущей операции.
 * @param cacheOption - Опции кеширования.
 * @returns boolean указывающий, использовать ли кеш.
 */
function shouldUseCache(cacheOption: any): boolean {
  return (
    cacheOption !== undefined &&
    ["boolean", "object", "number", "string"].includes(typeof cacheOption)
  );
}

/**
 * Определяет, следует ли использовать удаление из кеша для текущей операции.
 * @param uncacheOption - Опции удаления кеша.
 * @returns boolean указывающий, использовать ли удаление кеша.
 */
function shouldUseUncache(uncacheOption: any): boolean {
  return (
    uncacheOption !== undefined &&
    (typeof uncacheOption === "function" ||
      typeof uncacheOption === "string" ||
      Array.isArray(uncacheOption))
  );
}

/**
 * Основная функция расширения Prisma для управления кешированием с использованием Redis.
 * @param config - Конфигурация для кеша Redis и TTL по умолчанию.
 * @returns Prisma расширение.
 */
export default ({ cache, defaultTTL }: PrismaRedisCacheConfig) => {
  return Prisma.defineExtension({
    name: "prisma-extension-cache-manager",
    client: {
      $cache: cache,
    },
    model: {
      $allModels: {} as ModelExtension,
    },
    query: {
      $allModels: {
        /**
         * Обрабатывает все операции моделей, добавляя логику кеширования.
         * @param params - Параметры операции.
         * @returns Результат операции, возможно из кеша.
         */
        async $allOperations({ model, operation, args, query }) {
          // Проверяем, относится ли операция к кешируемым
          if (!(CACHE_OPERATIONS as unknown as string[]).includes(operation)) {
            return query(args);
          }

          const isWriteOperation = [
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

          // Если не используем кеш, просто выполняем запрос и обрабатываем удаление кеша, если требуется
          if (!useCache) {
            const result = await query(queryArgs);
            if (useUncache) {
              await processUncache(cache, uncacheOption, result);
            }
            return result;
          }

          // Генерация ключа кеша
          let cacheKey: string;
          let ttl: number | undefined;

          if (["boolean", "number", "string"].includes(typeof cacheOption)) {
            cacheKey =
              typeof cacheOption === "string"
                ? cacheOption
                : generateComposedKey({ model, queryArgs });

            ttl = typeof cacheOption === "number" ? cacheOption : defaultTTL;
          } else if (typeof cacheOption.key === "function") {
            const result = await query(queryArgs);
            if (useUncache) {
              await processUncache(cache, uncacheOption, result);
            }

            cacheKey = cacheOption.key(result);
            ttl = cacheOption.ttl ?? defaultTTL;

            await cache.set(
              cacheKey,
              msgpack.encode(serializeData(result)),
              ttl
            );
            return result;
          } else {
            cacheKey =
              createKey(cacheOption.key, cacheOption.namespace) ||
              generateComposedKey({ model, queryArgs });

            ttl = cacheOption.ttl ?? defaultTTL;
          }

          // Для операций чтения пытаемся получить данные из кеша
          if (!isWriteOperation) {
            try {
              const cached = await cache.store.client.getBuffer(cacheKey);
              if (cached) {
                return deserializeData(msgpack.decode(cached));
              }
            } catch {}
          }

          // Выполняем запрос к базе данных
          const result = await query(queryArgs);

          // Обрабатываем удаление кеша, если требуется
          if (useUncache) {
            await processUncache(cache, uncacheOption, result);
          }

          // Сохраняем результат в кеш
          try {
            await cache.set(
              cacheKey,
              msgpack.encode(serializeData(result)),
              ttl
            );
          } catch {}

          return result;
        },
      },
    },
  });
};
