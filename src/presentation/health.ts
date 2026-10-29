import { Controller, Get, HttpCode, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiTags } from "@nestjs/swagger";
import { Database } from "../infrastructure/database";
import { SqsMessaging } from "../infrastructure/messaging/sqs";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly database: Database, private readonly messaging: SqsMessaging) {}

  @Get("live")
  @HttpCode(200)
  live() {
    return { status: "live" };
  }

  @Get("ready")
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) response: Response) {
    let postgres = false;
    let sqs = false;
    try {
      await this.database.query("SELECT 1 AS ready");
      postgres = true;
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "readiness_postgres_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
    try {
      sqs = await this.messaging.isReady();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "readiness_sqs_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
    const ready = postgres && sqs;
    response.status(ready ? 200 : 503);
    return { status: ready ? "ready" : "not_ready", dependencies: { postgres, sqs } };
  }
}
