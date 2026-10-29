import { randomUUID, createHash } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Database, type SqlExecutor } from "../infrastructure/database";
import { BusinessRejectionError, IdempotencyConflictError, InsufficientFundsError, type FailureCode } from "../domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../domain/ledger-entry";
import { InboxMessage, OutboxMessage } from "../domain/inbox-outbox";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { Money, type MoneyProps } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { canonicalPayloadHash, type WagerPayload } from "./payload-hash";
import { ProcessMetrics } from "../infrastructure/process-metrics";

type DbRow = Record<string, unknown>;

interface WalletRow extends DbRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TransactionRow extends DbRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  response_balance: string;
  response_currency: string;
  created_at: Date | string;
  processed_at: Date | string | null;
}

interface ReferenceRow extends TransactionRow {}

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface SubmitWagerInput extends WagerPayload {
  idempotencyKey: string;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
}

@Injectable()
export class WageringService {
  private readonly metrics: ProcessMetrics;

  constructor(
    private readonly database: Database,
    @Optional() @Inject(ProcessMetrics) metrics?: ProcessMetrics,
  ) {
    this.metrics = metrics ?? new ProcessMetrics();
  }

  async createWallet(input: CreateWalletInput): Promise<{
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
  }> {
    const initial = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const now = new Date();
    const wallet = Wallet.open({ id: walletId, playerId: input.playerId, initialBalance: initial, now });

    await this.database.transaction(async (db) => {
      await db.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toString(), wallet.version, now, now],
      );
      if (initial.isPositive()) {
        const transactionId = randomUUID();
        const payloadHash = createHash("sha256").update(`${walletId}:${initial.toString()}:${initial.currency}`).digest("hex");
        await db.execute(
          `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, amount, currency, status, response_balance, response_currency,
             created_at, processed_at)
           VALUES ($1, 'internal', $2, $2, $3, $4, $5, 'opening', 'internal', 'OPENING', $6, $7,
             'PROCESSED', $6, $7, $8, $8)`,
          [transactionId, `opening:${walletId}`, payloadHash, walletId, input.playerId, initial.toString(), initial.currency, now],
        );
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: now,
        });
        await this.insertLedger(db, entry);
        const event = WalletBalanceChanged.from({
          aggregateId: walletId,
          correlationId: transactionId,
          occurredAt: now,
          data: {
            walletId,
            transactionId,
            direction: LedgerDirection.Credit,
            money: initial.toJSON(),
            balanceBefore: Money.zero(initial.currency).toJSON(),
            balanceAfter: initial.toJSON(),
            walletVersion: wallet.version,
          },
        });
        await this.enqueue(db, event);
        await this.enqueue(db, WagerTransactionProcessed.from({
          aggregateId: transactionId,
          correlationId: transactionId,
          occurredAt: now,
          data: {
            transactionId,
            providerId: "internal",
            externalTransactionId: `opening:${walletId}`,
            status: WagerTransactionStatus.Processed,
            balance: initial.toJSON(),
          },
        }));
      }
    });

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async getWallet(walletId: string): Promise<{
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
  } | undefined> {
    const [row] = await this.database.query<WalletRow>(
      "SELECT id, player_id, currency, balance::text, version FROM wallets WHERE id = $1",
      [walletId],
    );
    if (!row) return undefined;
    return {
      id: row.id,
      playerId: row.player_id,
      balance: Money.from({ amount: row.balance, currency: row.currency.trim() }).toJSON(),
      version: row.version,
    };
  }

  async submit(input: SubmitWagerInput, inbox?: InboxContext, correlationId?: string): Promise<TransactionResult> {
    if (input.kind === WagerTransactionKind.Opening) throw new RangeError("OPENING is internal only");
    if ((input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) &&
      !input.referenceExternalTransactionId) {
      throw new RangeError(`${input.kind} requires a reference`);
    }
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new RangeError("Transaction amount must be positive");
    const payloadHash = canonicalPayloadHash(input);
    const now = new Date();
    const proposedTransactionId = randomUUID();
    const transactionProps = {
      id: proposedTransactionId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    } as const;
    WagerTransaction.create(transactionProps);

    const startedAt = performance.now();
    try {
      const result = await this.database.transaction(async (db) => {
      if (inbox) {
        const received = InboxMessage.receive({
          messageId: inbox.messageId,
          consumerName: inbox.consumerName,
          payloadHash,
          receivedAt: now,
        });
        const inboxInsert = await db.execute(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING message_id`,
          [received.state.consumerName, received.state.messageId, received.state.payloadHash, received.state.receivedAt],
        );
        if (inboxInsert.length === 0) {
          const [existingInbox] = await db.execute<DbRow & { payload_hash: string; processed_at: Date | null }>(
            `SELECT payload_hash, processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
            [inbox.consumerName, inbox.messageId],
          );
          if (!existingInbox || existingInbox.payload_hash !== payloadHash) throw new IdempotencyConflictError();
          if (existingInbox.processed_at) {
            this.metrics.increment("duplicates");
            const result = await this.findExistingResult(db, input.providerId, input.idempotencyKey, payloadHash);
            return { ...result, idempotentReplay: true };
          }
        }
      }

      const created = await db.execute(
        `INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, reference_external_transaction_id, status,
           response_balance, response_currency, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING', '0.00', $12, $14)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          proposedTransactionId,
          input.providerId,
          input.externalTransactionId,
          input.idempotencyKey,
          payloadHash,
          input.walletId,
          input.playerId,
          input.roundId,
          input.gameId,
          input.kind,
          input.money.amount,
          input.money.currency,
          input.referenceExternalTransactionId ?? null,
          now,
        ],
      );

      if (created.length === 0) {
        this.metrics.increment("duplicates");
        const result = await this.findExistingResult(db, input.providerId, input.idempotencyKey, payloadHash, input.externalTransactionId);
        if (inbox) await this.markInboxProcessed(db, inbox, now);
        return { ...result, idempotentReplay: true };
      }

      const domainTransaction = WagerTransaction.create(transactionProps);
      let result: TransactionResult;
      try {
        result = await this.processNewTransaction(db, proposedTransactionId, input, now);
        if (result.status === WagerTransactionStatus.Processed) {
          domainTransaction.markProcessed(undefined, now);
        } else if (result.status === WagerTransactionStatus.PendingReference) {
          domainTransaction.markPendingReference();
        } else if (result.status === WagerTransactionStatus.Rejected) {
          domainTransaction.reject(result.failureCode ?? "INVALID_TRANSACTION");
        }
      } catch (error) {
        if (error instanceof BusinessRejectionError) {
          result = await this.reject(db, proposedTransactionId, input, error.failureCode, now);
          domainTransaction.reject(error.failureCode);
        } else if (error instanceof InsufficientFundsError) {
          result = await this.reject(db, proposedTransactionId, input, error.failureCode, now);
          domainTransaction.reject(error.failureCode);
        } else {
          throw error;
        }
      }
      if (inbox) await this.markInboxProcessed(db, inbox, now);
      return result;
      });
      console.info(JSON.stringify({
        level: "info",
        event: "wager_transaction_completed",
        correlationId: correlationId ?? inbox?.messageId ?? result.transactionId,
        messageId: inbox?.messageId ?? null,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      }));
      return result;
    } finally {
      this.metrics.observeProcessing((performance.now() - startedAt) / 1_000);
    }
  }

  async getTransaction(transactionId: string): Promise<TransactionResult | undefined> {
    const [row] = await this.database.query<TransactionRow>(
      "SELECT * FROM wager_transactions WHERE id = $1",
      [transactionId],
    );
    return row ? this.toResult(row, false) : undefined;
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string): Promise<TransactionResult | undefined> {
    const [row] = await this.database.query<TransactionRow>(
      "SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2",
      [providerId, externalTransactionId],
    );
    return row ? this.toResult(row, false) : undefined;
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<{
    entries: DbRow[];
    nextCursor: string | null;
  }> {
    let rows: DbRow[];
    if (cursor) {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8").split("|");
      if (decoded.length !== 2 || !decoded[0] || !decoded[1] ||
        Number.isNaN(Date.parse(decoded[0])) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded[1])) {
        throw new RangeError("Invalid ledger cursor");
      }
      rows = await this.database.query(
        `SELECT id, transaction_id, direction, amount::text, currency, balance_before::text,
                balance_after::text, created_at
         FROM wallet_ledger_entries
         WHERE wallet_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [walletId, decoded[0], decoded[1], limit + 1],
      );
    } else {
      rows = await this.database.query(
        `SELECT id, transaction_id, direction, amount::text, currency, balance_before::text,
                balance_after::text, created_at
         FROM wallet_ledger_entries WHERE wallet_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [walletId, limit + 1],
      );
    }
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const last = entries.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(`${new Date(String(last.created_at)).toISOString()}|${String(last.id)}`).toString("base64url")
      : null;
    return { entries, nextCursor };
  }

  async reconcile(walletId: string): Promise<{
    walletId: string;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    consistent: boolean;
    checkedEntries: number;
  } | undefined> {
    const [row] = await this.database.query<DbRow & {
      id: string;
      currency: string;
      balance: string;
      calculated_balance: string;
      checked_entries: string;
    }>(
      `SELECT wallets.id, wallets.currency, wallets.balance::text AS balance,
              COALESCE(SUM(CASE WHEN wallet_ledger_entries.direction = 'CREDIT'
                                THEN wallet_ledger_entries.amount
                                ELSE -wallet_ledger_entries.amount END), 0)::numeric(18, 2)::text AS calculated_balance,
              COUNT(wallet_ledger_entries.id)::text AS checked_entries
       FROM wallets
       LEFT JOIN wallet_ledger_entries ON wallet_ledger_entries.wallet_id = wallets.id
       WHERE wallets.id = $1
       GROUP BY wallets.id, wallets.currency, wallets.balance`,
      [walletId],
    );
    if (!row) return undefined;
    const currency = row.currency.trim();
    const stored = Money.from({ amount: row.balance, currency });
    const calculated = Money.from({ amount: row.calculated_balance, currency });
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: stored.equals(calculated),
      checkedEntries: Number(row.checked_entries),
    };
  }

  async processPendingReferences(limit = 50): Promise<number> {
    const due = await this.database.query<DbRow & { id: string }>(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY next_attempt_at NULLS FIRST, created_at
       LIMIT $1`,
      [limit],
    );
    let completed = 0;
    for (const pending of due) {
      const [row] = await this.database.query<TransactionRow>(
        "SELECT * FROM wager_transactions WHERE id = $1",
        [pending.id],
      );
      if (!row) continue;
      const input: SubmitWagerInput = {
        providerId: row.provider_id,
        externalTransactionId: row.external_transaction_id,
        idempotencyKey: row.idempotency_key,
        playerId: row.player_id,
        walletId: row.wallet_id,
        roundId: row.round_id,
        gameId: row.game_id,
        kind: row.kind,
        money: { amount: row.amount, currency: row.currency.trim() },
        ...(row.reference_external_transaction_id
          ? { referenceExternalTransactionId: row.reference_external_transaction_id }
          : {}),
      };
      await this.retryPending(row.id, input);
      completed += 1;
    }
    return completed;
  }

  private async retryPending(transactionId: string, input: SubmitWagerInput): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (db) => {
      const [existing] = await db.execute<TransactionRow>(
        `SELECT * FROM wager_transactions WHERE id = $1 AND status = 'PENDING_REFERENCE'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2) FOR UPDATE`,
        [transactionId, now],
      );
      if (!existing || existing.status !== WagerTransactionStatus.PendingReference) return;
      const [wallet] = await db.execute<WalletRow>(
        "SELECT id, player_id, currency, balance::text, version, created_at, updated_at FROM wallets WHERE id = $1 FOR UPDATE",
        [existing.wallet_id],
      );
      if (!wallet) return;
      const reference = await this.findReference(db, input);
      const attempts = Number(existing.reference_attempts) + 1;
      if (!reference) {
        if (attempts >= 12) {
          await this.rejectExisting(db, existing, wallet, "REFERENCE_NOT_FOUND", now);
          return;
        }
        const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
        await db.execute(
          `UPDATE wager_transactions SET reference_attempts = $2, next_attempt_at = $3 WHERE id = $1`,
          [transactionId, attempts, new Date(now.getTime() + delay)],
        );
        return;
      }
      try {
        this.validateReference(input, wallet, reference);
        if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
          if (attempts >= 12) {
            await this.rejectExisting(db, existing, wallet, "REFERENCE_NOT_FOUND", now);
            return;
          }
          const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
          await db.execute(
            `UPDATE wager_transactions SET reference_attempts = $2, next_attempt_at = $3 WHERE id = $1`,
            [transactionId, attempts, new Date(now.getTime() + delay)],
          );
          return;
        }
        await this.applyExisting(db, existing, wallet, reference, now);
      } catch (error) {
        if (error instanceof BusinessRejectionError) await this.rejectExisting(db, existing, wallet, error.failureCode, now);
        else if (error instanceof InsufficientFundsError) await this.rejectExisting(db, existing, wallet, "ROLLBACK_WOULD_OVERDRAW", now);
        else throw error;
      }
    });
  }

  private async processNewTransaction(
    db: SqlExecutor,
    transactionId: string,
    input: SubmitWagerInput,
    now: Date,
  ): Promise<TransactionResult> {
    const [wallet] = await db.execute<WalletRow>(
      `SELECT id, player_id, currency, balance::text, version, created_at, updated_at
       FROM wallets WHERE id = $1 FOR UPDATE`,
      [input.walletId],
    );
    if (!wallet) return this.reject(db, transactionId, input, "WALLET_NOT_FOUND", now);
    if (wallet.player_id !== input.playerId) return this.reject(db, transactionId, input, "WALLET_IDENTITY_MISMATCH", now, wallet);
    if (wallet.currency.trim() !== input.money.currency) return this.reject(db, transactionId, input, "CURRENCY_MISMATCH", now, wallet);

    const money = Money.from(input.money);
    const walletAggregate = rehydrateWallet(wallet);
    const balanceBefore = walletAggregate.balance;
    const row = await this.findTransaction(db, transactionId);
    if (!row) throw new Error("Inserted wager transaction was not found");

    if (input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) {
      const reference = await this.findReference(db, input);
      if (!reference) {
        return this.markPendingReference(db, transactionId, input, balanceBefore, now);
      }
      this.validateReference(input, wallet, reference);
      if (reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference) {
        return this.markPendingReference(db, transactionId, input, balanceBefore, now);
      }
      await this.applyExisting(db, row, wallet, reference, now);
      return this.resultAfterUpdate(db, transactionId, false);
    }

    let direction: LedgerDirection | undefined;
    let referenceTransactionId: string | null = null;
    if (input.kind === WagerTransactionKind.Bet) direction = LedgerDirection.Debit;
    if (input.kind === WagerTransactionKind.Win) direction = LedgerDirection.Credit;
    if (input.kind === WagerTransactionKind.Win && input.referenceExternalTransactionId) {
      const reference = await this.findReference(db, input);
      if (!reference) throw new BusinessRejectionError("REFERENCE_NOT_FOUND", "WIN reference was not found");
      this.validateReference(input, wallet, reference);
      if (reference.kind !== WagerTransactionKind.Bet || reference.status !== WagerTransactionStatus.Processed) {
        throw new BusinessRejectionError("INVALID_REFERENCE", "WIN may only refer to a processed BET");
      }
      referenceTransactionId = reference.id;
    }

    let balanceAfter = balanceBefore;
    if (direction === LedgerDirection.Debit) balanceAfter = walletAggregate.debit(money, now).after;
    if (direction === LedgerDirection.Credit) balanceAfter = walletAggregate.credit(money, now).after;

    if (direction) {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId,
        direction,
        money,
        balanceBefore,
        balanceAfter,
        createdAt: now,
      });
      await db.execute(
        "UPDATE wallets SET balance = $2, version = $3, updated_at = $4 WHERE id = $1",
        [wallet.id, balanceAfter.toString(), walletAggregate.version, now],
      );
      await this.insertLedger(db, entry);
      const changed = WalletBalanceChanged.from({
        aggregateId: wallet.id,
        correlationId: transactionId,
        occurredAt: now,
        data: {
          walletId: wallet.id,
          transactionId,
          direction,
          money: money.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: balanceAfter.toJSON(),
          walletVersion: walletAggregate.version,
        },
      });
      await this.enqueue(db, changed);
    }

    const balance = balanceAfter.toJSON();
    await db.execute(
      `UPDATE wager_transactions SET status = 'PROCESSED', response_balance = $2, response_currency = $3,
         processed_at = $4, reference_transaction_id = $5 WHERE id = $1`,
      [transactionId, balance.amount, balance.currency, now, referenceTransactionId],
    );
    const result: TransactionResult = { transactionId, status: WagerTransactionStatus.Processed, balance, idempotentReplay: false };
    await this.enqueue(db, WagerTransactionProcessed.from({
      aggregateId: transactionId,
      correlationId: transactionId,
      occurredAt: now,
      data: this.wagerEventData(input, result),
    }));
    return result;
  }

  private async applyExisting(
    db: SqlExecutor,
    transaction: TransactionRow,
    wallet: WalletRow,
    reference: ReferenceRow,
    now: Date,
  ): Promise<void> {
    const input: SubmitWagerInput = {
      providerId: transaction.provider_id,
      externalTransactionId: transaction.external_transaction_id,
      idempotencyKey: transaction.idempotency_key,
      playerId: transaction.player_id,
      walletId: transaction.wallet_id,
      roundId: transaction.round_id,
      gameId: transaction.game_id,
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency.trim() },
      ...(transaction.reference_external_transaction_id
        ? { referenceExternalTransactionId: transaction.reference_external_transaction_id }
        : {}),
    };
    this.validateReference(input, wallet, reference);
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRejectionError("REFERENCE_NOT_PROCESSED", "Referenced transaction is not processed");
    }
    if (transaction.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw new BusinessRejectionError("INVALID_REFERENCE", "REFUND may only refer to a BET");
    }
    if (transaction.kind === WagerTransactionKind.Rollback &&
      ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)) {
      throw new BusinessRejectionError("INVALID_REFERENCE", "ROLLBACK reference kind is not reversible");
    }
    const amount = Money.from({ amount: transaction.amount, currency: transaction.currency.trim() });
    const referenceAmount = Money.from({ amount: reference.amount, currency: reference.currency.trim() });
    if (!amount.equals(referenceAmount)) throw new BusinessRejectionError("INVALID_REFERENCE", "Reversal amount must match its reference");
    const domainTransaction = this.rehydrateTransaction(transaction);
    domainTransaction.markProcessed(reference.id, now);

    const duplicate = await db.execute(
      `SELECT id FROM wager_transactions WHERE reference_transaction_id = $1 AND kind = $2 AND status = 'PROCESSED'`,
      [reference.id, transaction.kind],
    );
    if (duplicate.length > 0) throw new BusinessRejectionError("DUPLICATE_REVERSAL", "Reference was already reversed by this operation type");

    const referenceDirection = reference.kind === WagerTransactionKind.Bet || reference.kind === WagerTransactionKind.Rollback
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
    const direction = transaction.kind === WagerTransactionKind.Refund
      ? LedgerDirection.Credit
      : referenceDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    const walletAggregate = rehydrateWallet(wallet);
    const balanceBefore = walletAggregate.balance;
    let balanceAfter: Money;
    try {
      balanceAfter = direction === LedgerDirection.Credit
        ? walletAggregate.credit(amount, now).after
        : walletAggregate.debit(amount, now).after;
    } catch (error) {
      if (error instanceof InsufficientFundsError) throw new InsufficientFundsError("ROLLBACK_WOULD_OVERDRAW");
      throw error;
    }

    const ledger = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
    await db.execute(
      "UPDATE wallets SET balance = $2, version = $3, updated_at = $4 WHERE id = $1",
      [wallet.id, balanceAfter.toString(), walletAggregate.version, now],
    );
    await this.insertLedger(db, ledger);
    await db.execute(
      `UPDATE wager_transactions SET status = 'PROCESSED', reference_transaction_id = $2,
         response_balance = $3, response_currency = $4, processed_at = $5,
         reference_attempts = reference_attempts + 1, next_attempt_at = NULL WHERE id = $1`,
      [transaction.id, reference.id, balanceAfter.toString(), balanceAfter.currency, now],
    );
    const walletEvent = WalletBalanceChanged.from({
      aggregateId: wallet.id,
      correlationId: transaction.id,
      occurredAt: now,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: amount.toJSON(),
        balanceBefore: balanceBefore.toJSON(),
        balanceAfter: balanceAfter.toJSON(),
        walletVersion: walletAggregate.version,
      },
    });
    await this.enqueue(db, walletEvent);
    const result: TransactionResult = {
      transactionId: transaction.id,
      status: WagerTransactionStatus.Processed,
      balance: balanceAfter.toJSON(),
      idempotentReplay: false,
    };
    await this.enqueue(db, WagerTransactionProcessed.from({
      aggregateId: transaction.id,
      correlationId: transaction.id,
      occurredAt: now,
      data: this.wagerEventData(input, result),
    }));
  }

  private validateReference(input: SubmitWagerInput, wallet: WalletRow, reference: ReferenceRow): void {
    if (reference.provider_id !== input.providerId || reference.player_id !== input.playerId ||
      reference.wallet_id !== input.walletId || reference.currency.trim() !== input.money.currency ||
      reference.round_id !== input.roundId || wallet.id !== input.walletId) {
      throw new BusinessRejectionError("INVALID_REFERENCE", "Reference does not match provider, player, wallet, currency, or round");
    }
  }

  private async markPendingReference(
    db: SqlExecutor,
    transactionId: string,
    input: SubmitWagerInput,
    balance: Money,
    now: Date,
  ): Promise<TransactionResult> {
    const domainTransaction = WagerTransaction.create({
      id: transactionId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: canonicalPayloadHash(input),
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });
    domainTransaction.markPendingReference();
    const snapshot = balance.toJSON();
    await db.execute(
      `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', response_balance = $2,
         next_attempt_at = $3 WHERE id = $1`,
      [transactionId, snapshot.amount, new Date(now.getTime() + 1_000)],
    );
    const result: TransactionResult = {
      transactionId,
      status: WagerTransactionStatus.PendingReference,
      balance: snapshot,
      idempotentReplay: false,
    };
    await this.enqueue(db, WagerTransactionPendingReference.from({
      aggregateId: transactionId,
      correlationId: transactionId,
      occurredAt: now,
      data: this.wagerEventData(input, result),
    }));
    return result;
  }

  private async findReference(db: SqlExecutor, input: SubmitWagerInput): Promise<ReferenceRow | undefined> {
    if (!input.referenceExternalTransactionId) return undefined;
    const [row] = await db.execute<ReferenceRow>(
      `SELECT * FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [input.providerId, input.referenceExternalTransactionId],
    );
    return row;
  }

  private async findTransaction(db: SqlExecutor, id: string): Promise<TransactionRow | undefined> {
    const [row] = await db.execute<TransactionRow>("SELECT * FROM wager_transactions WHERE id = $1", [id]);
    return row;
  }

  private async reject(
    db: SqlExecutor,
    transactionId: string,
    input: SubmitWagerInput,
    failureCode: FailureCode,
    now: Date,
    wallet?: WalletRow,
  ): Promise<TransactionResult> {
    const balance = wallet && wallet.currency.trim() === input.money.currency
      ? Money.from({ amount: wallet.balance, currency: wallet.currency.trim() }).toJSON()
      : Money.zero(input.money.currency).toJSON();
    await db.execute(
      `UPDATE wager_transactions SET status = 'REJECTED', failure_code = $2,
         response_balance = $3, response_currency = $4, processed_at = $5 WHERE id = $1`,
      [transactionId, failureCode, balance.amount, balance.currency, now],
    );
    const result: TransactionResult = {
      transactionId,
      status: WagerTransactionStatus.Rejected,
      balance,
      idempotentReplay: false,
      failureCode,
    };
    await this.enqueue(db, WagerTransactionRejected.from({
      aggregateId: transactionId,
      correlationId: transactionId,
      occurredAt: now,
      data: this.wagerEventData(input, result),
    }));
    return result;
  }

  private async rejectExisting(
    db: SqlExecutor,
    transaction: TransactionRow,
    wallet: WalletRow,
    failureCode: FailureCode,
    now: Date,
  ): Promise<void> {
    const input: SubmitWagerInput = {
      providerId: transaction.provider_id,
      externalTransactionId: transaction.external_transaction_id,
      idempotencyKey: transaction.idempotency_key,
      playerId: transaction.player_id,
      walletId: transaction.wallet_id,
      roundId: transaction.round_id,
      gameId: transaction.game_id,
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency.trim() },
      ...(transaction.reference_external_transaction_id
        ? { referenceExternalTransactionId: transaction.reference_external_transaction_id }
        : {}),
    };
    this.rehydrateTransaction(transaction).reject(failureCode);
    await this.reject(db, transaction.id, input, failureCode, now, wallet);
    await db.execute(
      "UPDATE wager_transactions SET reference_attempts = reference_attempts + 1, next_attempt_at = NULL WHERE id = $1",
      [transaction.id],
    );
  }

  private async resultAfterUpdate(db: SqlExecutor, transactionId: string, replay: boolean): Promise<TransactionResult> {
    const [row] = await db.execute<TransactionRow>("SELECT * FROM wager_transactions WHERE id = $1", [transactionId]);
    if (!row) throw new Error("Wager transaction disappeared during processing");
    return this.toResult(row, replay);
  }

  private async findExistingResult(
    db: SqlExecutor,
    providerId: string,
    idempotencyKey: string,
    payloadHash: string,
    externalTransactionId?: string,
  ): Promise<TransactionResult> {
    const [row] = await db.execute<TransactionRow>(
      `SELECT * FROM wager_transactions
       WHERE provider_id = $1 AND (idempotency_key = $2 OR ($3::text IS NOT NULL AND external_transaction_id = $3))
       ORDER BY CASE WHEN idempotency_key = $2 THEN 0 ELSE 1 END LIMIT 1`,
      [providerId, idempotencyKey, externalTransactionId ?? null],
    );
    if (!row || row.idempotency_key !== idempotencyKey || row.payload_hash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    return this.toResult(row, true);
  }

  private toResult(row: TransactionRow, idempotentReplay: boolean): TransactionResult {
    return {
      transactionId: row.id,
      status: row.status,
      balance: Money.from({ amount: row.response_balance, currency: row.response_currency.trim() }).toJSON(),
      idempotentReplay,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };
  }

  private async insertLedger(db: SqlExecutor, entry: WalletLedgerEntry): Promise<void> {
    const props = entry.props;
    await db.execute(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, balance_currency, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $9)`,
      [
        props.id,
        props.walletId,
        props.transactionId,
        props.direction,
        props.money.toString(),
        props.money.currency,
        props.balanceBefore.toString(),
        props.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  private async enqueue(db: SqlExecutor, event: { toJSON(): Record<string, unknown>; eventId: string; eventType: string; props: { aggregateId: string }; occurredAt: Date }): Promise<void> {
    const message = OutboxMessage.enqueue({
      id: event.eventId,
      aggregateId: event.props.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
    });
    await db.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        message.state.id,
        message.state.aggregateId,
        message.state.eventType,
        JSON.stringify(message.state.payload),
        message.state.occurredAt,
      ],
    );
  }

  private async markInboxProcessed(db: SqlExecutor, inbox: InboxContext, at: Date): Promise<void> {
    await db.execute(
      "UPDATE inbox_messages SET processed_at = $3 WHERE consumer_name = $1 AND message_id = $2",
      [inbox.consumerName, inbox.messageId, at],
    );
  }

  private wagerEventData(input: SubmitWagerInput, result: TransactionResult) {
    return {
      transactionId: result.transactionId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      status: result.status,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      balance: result.balance,
    };
  }

  private rehydrateTransaction(row: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.from({ amount: row.amount, currency: row.currency.trim() }),
      ...(row.reference_external_transaction_id
        ? { referenceExternalTransactionId: row.reference_external_transaction_id }
        : {}),
      ...(row.reference_transaction_id ? { referenceTransactionId: row.reference_transaction_id } : {}),
      status: row.status,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      ...(row.processed_at ? { processedAt: asDate(row.processed_at) } : {}),
      createdAt: asDate(row.created_at),
    });
  }
}

function rehydrateWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency.trim(),
    balance: Money.from({ amount: row.balance, currency: row.currency.trim() }),
    version: Number(row.version),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
