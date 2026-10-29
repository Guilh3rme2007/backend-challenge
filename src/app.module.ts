import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migration20261029000100 } from "./migrations/001_initial";
import { WageringService } from "./application/wagering-service";
import { Database, ORM } from "./infrastructure/database";
import { OutboxPublisher, PendingReferenceWorker } from "./infrastructure/outbox-publisher";
import { SqsMessaging, SqsTransactionConsumer } from "./infrastructure/messaging/sqs";
import { HealthController } from "./presentation/health";
import { MetricsController } from "./presentation/metrics";
import { WalletController, WageringController } from "./presentation/controllers";
import { ProcessMetrics } from "./infrastructure/process-metrics";

@Module({
  controllers: [WalletController, WageringController, HealthController, MetricsController],
  providers: [
    {
      provide: ORM,
      useFactory: async () => MikroORM.init({
        driver: PostgreSqlDriver,
        clientUrl: process.env.DATABASE_URL ?? "postgresql://wager:wager@localhost:5432/wagering",
        entities: [],
        discovery: { warnWhenNoEntities: false },
        migrations: {
          migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
        },
        pool: { min: 2, max: 10 },
        connect: true,
        debug: false,
      }),
    },
    Database,
    ProcessMetrics,
    WageringService,
    SqsMessaging,
    SqsTransactionConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
