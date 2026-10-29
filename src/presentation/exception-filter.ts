import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DomainError } from "../domain/errors";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const mapped = mapError(error);
    const correlationId = request.header("x-correlation-id") ?? undefined;
    if (mapped.status >= 500) {
      const body = typeof request.body === "object" && request.body !== null
        ? request.body as Record<string, unknown>
        : {};
      console.error(JSON.stringify({
        level: "error",
        event: "http_request_failed",
        correlationId: correlationId ?? null,
        messageId: null,
        transactionId: stringField(body, "transactionId"),
        walletId: stringField(body, "walletId"),
        providerId: stringField(body, "providerId"),
        method: request.method,
        path: request.path,
        status: mapped.status,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
    response.status(mapped.status).json({
      statusCode: mapped.status,
      code: mapped.code,
      message: mapped.message,
      ...(correlationId ? { correlationId } : {}),
    });
  }
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  return typeof body[key] === "string" ? body[key] : null;
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const payload = error.getResponse();
    if (typeof payload === "object" && payload !== null && "code" in payload && "message" in payload) {
      return {
        status,
        code: String(payload.code),
        message: String(payload.message),
      };
    }
    return { status, code: status === 400 ? "INVALID_REQUEST" : "HTTP_ERROR", message: messageOf(payload) };
  }
  if (error instanceof DomainError) {
    if (error.code === "TRANSIENT_INFRASTRUCTURE_FAILURE") {
      return { status: 503, code: error.code, message: error.message };
    }
    const status = error.code === "IDEMPOTENCY_CONFLICT" || error.code === "TRANSACTION_ID_CONFLICT" ? 409 :
      error.code === "INSUFFICIENT_FUNDS" || error.code === "ROLLBACK_WOULD_OVERDRAW" ? 422 : 400;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return { status: 400, code: "INVALID_REQUEST", message: error.message };
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "23505") return { status: 409, code: "RESOURCE_CONFLICT", message: "A conflicting resource already exists" };
    if (isTransientCode(String(error.code))) {
      return { status: 503, code: "TRANSIENT_INFRASTRUCTURE_FAILURE", message: "A dependency is temporarily unavailable" };
    }
    if (typeof error === "object" && error !== null && "cause" in error &&
      typeof error.cause === "object" && error.cause !== null && "code" in error.cause) {
      if (error.cause.code === "23505") {
        return { status: 409, code: "RESOURCE_CONFLICT", message: "A conflicting resource already exists" };
      }
      if (isTransientCode(String(error.cause.code))) {
        return { status: 503, code: "TRANSIENT_INFRASTRUCTURE_FAILURE", message: "A dependency is temporarily unavailable" };
      }
    }
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}

function isTransientCode(code: string): boolean {
  return ["40001", "40P01", "55P03", "57014", "08000", "08001", "08003", "08006",
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code);
}

function messageOf(payload: string | object): string {
  if (typeof payload === "string") return payload;
  if ("message" in payload) return Array.isArray(payload.message) ? payload.message.join(", ") : String(payload.message);
  return "Request failed";
}
