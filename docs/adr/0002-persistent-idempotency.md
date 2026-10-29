# ADR 0002: Database-backed idempotency

- Status: Accepted

## Context

At-least-once requests and SQS redelivery must not duplicate financial effects across restarts or instances.

## Decision

Enforce unique `(provider_id, idempotency_key)` and `(provider_id, external_transaction_id)` constraints. Persist a SHA-256 hash of canonical business fields and the original result balance on the transaction.

## Consequences

The database is the source of truth. Identical retries return the saved result, while key reuse with a different payload is a conflict. No process-local cache is needed for correctness.
