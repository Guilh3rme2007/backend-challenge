# ADR 0003: Transactional outbox

- Status: Accepted

## Context

Publishing directly to SQS before commit can expose rolled-back events; publishing after commit alone can lose events on process failure.

## Decision

Persist versioned event envelopes in PostgreSQL in the same transaction as financial writes. Publishers claim rows with `FOR UPDATE SKIP LOCKED`, send to SQS after commit, and mark success separately.

## Consequences

Delivery is at least once. Consumers must deduplicate using the stable event ID. A crash between SQS acceptance and the published marker may cause a duplicate, never a lost committed event.
