import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { WageringService, type SubmitWagerInput } from "../../src/application/wagering-service";
import { Database } from "../../src/infrastructure/database";
import { Migration20261029000100 } from "../../src/migrations/001_initial";

async function main(): Promise<void> {
  const [requestsJson, readyPath, releasePath] = process.argv.slice(2);
  if (!requestsJson || !readyPath || !releasePath || !process.env.TEST_DATABASE_URL) {
    throw new Error("Usage: worker-submit.ts <requests-json> <ready-file> <release-file>");
  }
  const requests = JSON.parse(requestsJson) as SubmitWagerInput[];
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: process.env.TEST_DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 1, max: 10 },
    migrations: {
      migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
    },
  });
  await writeFile(readyPath, "ready");
  try {
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const service = new WageringService(new Database(orm));
    const results = await Promise.all(requests.map((request) => service.submit(request)));
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
