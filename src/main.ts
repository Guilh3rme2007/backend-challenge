import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./presentation/exception-filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header("x-correlation-id");
    const correlationId = incoming && /^[a-zA-Z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    request.headers["x-correlation-id"] = correlationId;
    response.setHeader("x-correlation-id", correlationId);
    next();
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }));
  app.useGlobalFilters(new ApiExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor")
    .setDescription("Wallet and wagering transaction API")
    .setVersion("1.0")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
  console.log(JSON.stringify({ level: "info", event: "application_started", port, role: process.env.APP_ROLE ?? "api" }));
}

void bootstrap();
