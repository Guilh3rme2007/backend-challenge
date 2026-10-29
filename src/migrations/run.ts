import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migration20261029000100 } from "./001_initial";

const action = process.argv[2];
if (action !== "up" && action !== "down") {
  throw new Error("Usage: bun run migration:up | bun run migration:down");
}

async function run(): Promise<void> {
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: process.env.DATABASE_URL ?? "postgresql://wager:wager@localhost:5432/wagering",
    entities: [],
    discovery: { warnWhenNoEntities: false },
    migrations: { migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }] },
  });

  try {
    if (action === "up") await orm.getMigrator().up();
    else await orm.getMigrator().down();
  } finally {
    await orm.close(true);
  }
}

void run();
