import { createHash } from "node:crypto";
import { type MoneyProps } from "../domain/money";
import { type WagerTransactionKind } from "../domain/wager-transaction";

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalPayloadHash(payload: WagerPayload): string {
  const canonical = JSON.stringify(canonicalize({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money,
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  }));
  return createHash("sha256").update(canonical).digest("hex");
}
