import {
  CACHE_OPERATIONS,
  ModelExtension,
  PrismaRedisCacheConfig,
} from "./types";
import { createHash } from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client/extension";
import { createCodec, encode, decode } from "msgpack-lite";

/**
 * Создаем codec
 * В дальнейшем используем его encode/decode для сериализации/десериализации.
 */
const codec = createCodec();

const TYPE_DECIMAL = 0x07;
const TYPE_DATE = 0x0d;

/**
 * Регистрируем тип `Decimal`.
 * - При кодировании превращаем `Decimal` в строку.
 * - При декодировании восстанавливаем обратно в `Decimal`.
 */
codec.addExtPacker(TYPE_DECIMAL, Decimal, (decimal) => {
  return Buffer.from(decimal.toString());
});
codec.addExtUnpacker(TYPE_DECIMAL, (buffer) => {
  return new Decimal(buffer.toString());
});

/**
 * Регистрируем тип `Date`.
 * - При кодировании превращаем `Date` в строку.
 * - При декодировании восстанавливаем обратно в `Date`.
 */
codec.addExtPacker(TYPE_DATE, Date, (date) => {
  return Buffer.from(date.toISOString());
});
codec.addExtUnpacker(TYPE_DATE, (buffer) => {
  return new Date(buffer.toString());
});

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

/**
 * Сериализация данных
 */
function serialize(data) {
  return encode(data, { codec });
}

/**
 * Десериализация данных
 */
function deserialize(buffer: Buffer) {
  return decode(buffer, { codec });
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

  // 1) Если uncacheOption — функция, она может вернуть ключ(и) для удаления.
  if (typeof uncacheOption === "function") {
    const keys = uncacheOption(result);
    keysToDelete = Array.isArray(keys) ? keys : [keys];
  }
  // 2) Если строка — просто один ключ.
  else if (typeof uncacheOption === "string") {
    keysToDelete = [uncacheOption];
  }
  // 3) Если массив:
  else if (Array.isArray(uncacheOption)) {
    // 3a) Простой массив строк.
    if (typeof uncacheOption[0] === "string") {
      keysToDelete = uncacheOption;
    }
    // 3b) Массив объектов { namespace, key }.
    else if (typeof uncacheOption[0] === "object") {
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
export default ({ cache, debug, ttl: defaultTTL }: PrismaRedisCacheConfig) => {
  return Prisma.defineExtension({
    name: "prisma-extension-cache-manager",
    client: {
      // Делаем кеш доступным в клиенте через $cache
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

          // Операции, при которых данные в БД меняются
          const isWriteOperation = [
            "create",
            "createMany",
            "updateMany",
            "upsert",
            "update",
          ].includes(operation);

          // Извлекаем специальные поля cache / uncache (если есть)
          const {
            cache: cacheOption,
            uncache: uncacheOption,
            ...queryArgs
          } = args as any;

          const useCache = shouldUseCache(cacheOption);
          const useUncache = shouldUseUncache(uncacheOption);

          // 1. Если кеш не нужен, просто выполняем запрос и,
          //    при необходимости, очищаем кеш (uncache).
          if (!useCache) {
            const result = await query(queryArgs);
            if (useUncache) {
              await processUncache(cache, uncacheOption, result);
            }
            return result;
          }

          // 2. Генерируем ключ кеша + TTL
          let cacheKey: string;
          let ttl: number | undefined;

          // 2a) Простые варианты cacheOption (true, число, строка)
          if (["boolean", "number", "string"].includes(typeof cacheOption)) {
            cacheKey =
              typeof cacheOption === "string"
                ? cacheOption // Если cacheOption — строка, используем её как ключ напрямую
                : generateComposedKey({ model, queryArgs }); // Иначе генерируем ключ

            // Если cacheOption — число, оно означает TTL
            ttl = typeof cacheOption === "number" ? cacheOption : undefined;
          }
          // 2b) Если cacheOption — объект с key: function,
          //     нужно сначала сделать запрос к БД, чтобы функция могла сгенерировать ключ
          else if (typeof cacheOption.key === "function") {
            // Выполняем запрос к базе
            const result = await query(queryArgs);

            // Если нужно, удаляем из кеша
            if (useUncache) {
              await processUncache(cache, uncacheOption, result);
            }

            // Функция генерирует ключ на основе результатов
            cacheKey = cacheOption.key(result);
            ttl = cacheOption.ttl;

            if (ttl === undefined) {
              ttl = defaultTTL;
            }

            if (ttl) {
              ttl = Math.ceil(ttl);
            }

            // Сохраняем результат в кеш
            try {
              const encoded = serialize(result);
              await (ttl && ttl > 0
                ? cache.store.client.set(cacheKey, encoded, "EX", ttl / 1000)
                : cache.store.client.set(cacheKey, encoded));
              if (debug) {
                console.log(
                  "Data cached with key (function):",
                  cacheKey,
                  "encoded:",
                  encoded,
                  "decoded:",
                  result
                );
              }
            } catch (e) {
              if (debug) {
                console.error("Failed to set cache", e);
              }
            }

            return result;
          }
          // 2c) Иначе берём ключ/namespace/ttl из объекта
          else {
            cacheKey =
              createKey(cacheOption.key, cacheOption.namespace) ||
              generateComposedKey({ model, queryArgs });

            ttl = cacheOption.ttl;
          }

          // 3. Если это операция чтения, пробуем вернуть данные из кеша
          if (!isWriteOperation) {
            try {
              // Используем getBuffer, т.к. сохраняем бинарные данные
              const cached = await cache.store.client.getBuffer(cacheKey);
              if (cached) {
                const data = deserialize(cached);
                if (debug) {
                  console.log(
                    "Cache hit for key:",
                    cacheKey,
                    "data",
                    cached,
                    "decoded",
                    data
                  );
                }
                return data;
              } else {
                if (debug) {
                  console.log("Cache miss for key:", cacheKey);
                }
              }
            } catch (e) {
              if (debug) {
                console.error("Failed to get cache", e);
              }
            }
          }

          // 4. Выполняем запрос к БД (операция чтения или записи)
          const result = await query(queryArgs);

          // 5. Если нужно, удаляем ключи из кеша
          if (useUncache) {
            await processUncache(cache, uncacheOption, result);
          }

          if (ttl === undefined) {
            ttl = defaultTTL;
          }

          if (ttl) {
            ttl = Math.ceil(ttl);
          }

          // 6. Сохраняем результат запроса в кеш
          try {
            const encoded = serialize(result);
            await (ttl && ttl > 0
              ? cache.store.client.set(cacheKey, encoded, "EX", ttl / 1000)
              : cache.store.client.set(cacheKey, encoded));
            if (debug) {
              console.log(
                "Data cached with key:",
                cacheKey,
                "encoded:",
                encoded,
                "decoded:",
                result
              );
            }
          } catch (e) {
            if (debug) {
              console.error("Failed to set cache", e);
            }
          }

          return result;
        },
      },
    },
  });
};
