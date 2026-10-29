import { describe, expect, it } from "bun:test";
import { canonicalPayloadHash, type WagerPayload } from "../../src/application/payload-hash";
import { WagerTransactionKind } from "../../src/domain/wager-transaction";

describe("canonicalPayloadHash", () => {
  const payload: WagerPayload = {
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
  };

  it("is deterministic and insensitive to object key order", () => {
    expect(canonicalPayloadHash(payload)).toBe(canonicalPayloadHash({
      ...payload,
      money: { currency: "BRL", amount: "25.00" },
    }));
  });

  it("changes when a business field changes", () => {
    expect(canonicalPayloadHash(payload)).not.toBe(canonicalPayloadHash({ ...payload, roundId: "round-2" }));
  });
});
