# ADR 0001: Wallet-level PostgreSQL locking

- Status: Accepted

## Context

Concurrent debits must never spend the same balance twice, while unrelated wallets should remain parallel.

## Decision

Lock the target wallet row with `SELECT ... FOR UPDATE` inside the same transaction that writes the balance, ledger, transaction result and outbox. Retry serialization failures and deadlocks at most twice.

## Consequences

PostgreSQL coordinates all application instances without an in-memory lock service. A hot wallet serializes by design; different wallets do not share an application-level lock.
