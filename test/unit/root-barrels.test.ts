import { describe, expect, it } from "bun:test";
import {
  InboxMessage,
  IntegrationEvent,
  OutboxMessage,
  type OutboxMessageState,
  type ReceiveInboxProps,
} from "../../inboxAndOutbox";
import { Money } from "../../money";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../../wagerTransaction";
import { Wallet } from "../../wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../walletLedgerEntry";

describe("root-level compatibility exports", () => {
  it("re-exports the canonical domain implementations rather than incomplete duplicate classes", () => {
    const inboxProps: ReceiveInboxProps = {
      messageId: "message",
      consumerName: "consumer",
      payloadHash: "a".repeat(64),
      receivedAt: new Date(),
    };
    const outboxProps: OutboxMessageState = {
      id: "event",
      aggregateId: "aggregate",
      eventType: "Example",
      payload: { eventId: "event" },
      occurredAt: new Date(),
      attempts: 0,
    };
    const transactionProps: CreateWagerTransactionProps = {
      id: "transaction",
      providerId: "provider",
      externalTransactionId: "external",
      idempotencyKey: "key",
      payloadHash: "b".repeat(64),
      walletId: "wallet",
      playerId: "player",
      roundId: "round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "1.00", currency: "BRL" }),
    };

    expect(InboxMessage.receive(inboxProps).isProcessed()).toBe(false);
    expect(OutboxMessage.enqueue({
      id: outboxProps.id,
      aggregateId: outboxProps.aggregateId,
      eventType: outboxProps.eventType,
      payload: outboxProps.payload,
      occurredAt: outboxProps.occurredAt,
    }).isPending()).toBe(true);
    expect(WagerTransaction.create(transactionProps).kind).toBe(WagerTransactionKind.Bet);
    expect(Wallet.open({
      id: "wallet",
      playerId: "player",
      initialBalance: Money.zero("BRL"),
    }).version).toBe(1);
    expect(String(LedgerDirection.Debit)).toBe("DEBIT");
    expect(WalletLedgerEntry).toBeDefined();
    expect(IntegrationEvent).toBeDefined();
  });
});
