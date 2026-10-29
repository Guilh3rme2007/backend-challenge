import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(18, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency),
        UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(18, 2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        response_balance numeric(18, 2) NOT NULL,
        response_currency char(3) NOT NULL,
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (provider_id, idempotency_key),
        CHECK (currency = response_currency),
        UNIQUE (id, wallet_id, currency)
      );
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (next_attempt_at, created_at)
        WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX wager_transactions_wallet_created_idx
        ON wager_transactions (wallet_id, created_at DESC, id DESC);
      CREATE INDEX wager_transactions_reference_lookup_idx
        ON wager_transactions (provider_id, external_transaction_id);
      CREATE UNIQUE INDEX wager_transactions_single_reversal_idx
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(18, 2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(18, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(18, 2) NOT NULL CHECK (balance_after >= 0),
        balance_currency char(3) NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE (wallet_id, transaction_id),
        CHECK (currency = balance_currency),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        CHECK (
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
          OR (direction = 'CREDIT' AND balance_before + amount = balance_after)
        )
      );
      CREATE INDEX wallet_ledger_cursor_idx
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);

      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only';
      END;
      $$;
      CREATE TRIGGER wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
      CREATE TRIGGER wallet_ledger_truncate_immutable
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();

      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        claimed_by text,
        claimed_until timestamptz,
        dead_lettered_at timestamptz,
        last_error text
      );
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM wallets) OR
           EXISTS (SELECT 1 FROM wager_transactions) OR
           EXISTS (SELECT 1 FROM wallet_ledger_entries) OR
           EXISTS (SELECT 1 FROM inbox_messages) OR
           EXISTS (SELECT 1 FROM outbox_messages) THEN
          RAISE EXCEPTION 'Refusing destructive down migration while financial data exists; use a reviewed restore/retirement procedure';
        END IF;
      END;
      $$;
      DROP TABLE outbox_messages;
      DROP TABLE inbox_messages;
      DROP TRIGGER wallet_ledger_truncate_immutable ON wallet_ledger_entries;
      DROP TRIGGER wallet_ledger_immutable ON wallet_ledger_entries;
      DROP TABLE wallet_ledger_entries;
      DROP FUNCTION reject_ledger_mutation();
      DROP TABLE wager_transactions;
      DROP TABLE wallets;
    `);
  }
}
