import { Inject, Injectable, OnApplicationShutdown, Optional } from "@nestjs/common";
import { MikroORM, type EntityManager } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { ProcessMetrics } from "./process-metrics";

export const ORM = Symbol("ORM");

export interface SqlExecutor {
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

@Injectable()
export class Database implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) readonly orm: MikroORM<PostgreSqlDriver>,
    @Optional() @Inject(ProcessMetrics) private readonly metrics?: ProcessMetrics,
  ) {}

  async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.run((executor) => executor.execute<T>(sql, params));
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.orm.em.fork().transactional(async (em: EntityManager) => {
          await em.getConnection().execute("SET LOCAL lock_timeout = '3s'");
          await em.getConnection().execute("SET LOCAL statement_timeout = '15s'");
          return work({
            execute: <R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
              em.getConnection().execute<R[]>(sql, [...params]),
          });
        });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === 2) throw error;
        this.metrics?.increment("retries");
        this.metrics?.increment("lockConflicts");
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.floor(Math.random() * 20)));
      }
    }
    throw new Error("Transaction retry loop ended unexpectedly");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }

  private async run<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) =>
      work({
        execute: <R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
          em.getConnection().execute<R[]>(sql, [...params]),
      }),
    );
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : undefined;
  if (code && ["40001", "40P01", "55P03"].includes(code)) return true;
  if ("cause" in error && typeof error.cause === "object" && error.cause !== null && "code" in error.cause) {
    return ["40001", "40P01", "55P03"].includes(String(error.cause.code));
  }
  return false;
}
