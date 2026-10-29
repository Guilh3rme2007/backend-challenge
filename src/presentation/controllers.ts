import {
  Body,
  Controller,
  ConflictException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { WageringService } from "../application/wagering-service";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { CreateWalletDto, SubmitWagerDto } from "./dto";
import { SqsMessaging } from "../infrastructure/messaging/sqs";
import { ProcessMetrics } from "../infrastructure/process-metrics";

@ApiTags("wallets")
@Controller("wallets")
export class WalletController {
  constructor(
    private readonly wagering: WageringService,
    private readonly metrics: ProcessMetrics,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a wallet and its optional opening ledger entry" })
  async create(@Body() body: CreateWalletDto) {
    try {
      return await this.wagering.createWallet(body);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: "WALLET_ALREADY_EXISTS", message: "A wallet already exists for this player and currency" });
      }
      throw error;
    }
  }

  @Get(":walletId")
  async get(@Param("walletId", ParseUUIDPipe) walletId: string) {
    const wallet = await this.wagering.getWallet(walletId);
    if (!wallet) throw new NotFoundException({ code: "WALLET_NOT_FOUND", message: "Wallet not found" });
    return wallet;
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", ParseUUIDPipe) walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limitValue?: string,
  ) {
    const limit = limitValue === undefined ? 50 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }
    if (!(await this.wagering.getWallet(walletId))) {
      throw new NotFoundException({ code: "WALLET_NOT_FOUND", message: "Wallet not found" });
    }
    const page = await this.wagering.listLedger(walletId, cursor, limit);
    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transaction_id,
        direction: entry.direction,
        money: Money.from({ amount: String(entry.amount), currency: String(entry.currency).trim() }).toJSON(),
        balanceBefore: Money.from({ amount: String(entry.balance_before), currency: String(entry.currency).trim() }).toJSON(),
        balanceAfter: Money.from({ amount: String(entry.balance_after), currency: String(entry.currency).trim() }).toJSON(),
        createdAt: new Date(String(entry.created_at)).toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId", ParseUUIDPipe) walletId: string) {
    const result = await this.wagering.reconcile(walletId);
    if (!result) throw new NotFoundException({ code: "WALLET_NOT_FOUND", message: "Wallet not found" });
    if (!result.consistent) {
      this.metrics.increment("reconciliationMismatches");
      console.error(JSON.stringify({ level: "error", event: "wallet_reconciliation_mismatch", walletId }));
    }
    return result;
  }
}

@ApiTags("wagering")
@Controller()
export class WageringController {
  constructor(
    private readonly wagering: WageringService,
    private readonly messaging: SqsMessaging,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Process a wagering transaction idempotently" })
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new RangeError("Idempotency-Key header is required");
    }
    if (body.kind === WagerTransactionKind.Opening) throw new RangeError("OPENING cannot be submitted externally");
    const result = await this.wagering.submit({ ...body, idempotencyKey }, undefined, correlationId);
    response.status(result.status === "PENDING_REFERENCE" ? 202 : result.status === "REJECTED" ? 422 : 200);
    return result;
  }

  @Post("wagering/transactions/queue")
  @HttpCode(202)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async enqueue(
    @Body() body: SubmitWagerDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey?.trim()) throw new RangeError("Idempotency-Key header is required");
    if (body.kind === WagerTransactionKind.Opening) throw new RangeError("OPENING cannot be submitted externally");
    const message = await this.messaging.enqueueWager({ ...body, idempotencyKey });
    return { messageId: message, status: "ACCEPTED" };
  }

  @Get("wagering/transactions/:transactionId")
  async getInternal(@Param("transactionId", ParseUUIDPipe) transactionId: string) {
    const result = await this.wagering.getTransaction(transactionId);
    if (!result) throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found" });
    return result;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const result = await this.wagering.getProviderTransaction(providerId, externalTransactionId);
    if (!result) throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found" });
    return result;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && typeof error.cause === "object" && error.cause !== null &&
    "code" in error.cause && error.cause.code === "23505";
}
