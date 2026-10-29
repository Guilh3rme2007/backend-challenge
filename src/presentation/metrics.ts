import { Controller, Get, Header } from "@nestjs/common";
import { Database } from "../infrastructure/database";
import { ProcessMetrics } from "../infrastructure/process-metrics";

@Controller()
export class MetricsController {
  constructor(
    private readonly database: Database,
    private readonly processMetrics: ProcessMetrics,
  ) {}

  @Get("metrics")
  @Header("content-type", "text/plain; version=0.0.4")
  async metrics(): Promise<string> {
    const rows = await this.database.query<Record<string, unknown> & { status: string; count: string }>(
      "SELECT status, count(*)::text AS count FROM wager_transactions GROUP BY status",
    );
    const pending = await this.database.query<Record<string, unknown> & { count: string }>(
      "SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL AND dead_lettered_at IS NULL",
    );
    const outboxLag = await this.database.query<Record<string, unknown> & { seconds: string | null }>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::text AS seconds
       FROM outbox_messages WHERE published_at IS NULL AND dead_lettered_at IS NULL`,
    );
    const deadLettered = await this.database.query<Record<string, unknown> & { count: string }>(
      "SELECT count(*)::text AS count FROM outbox_messages WHERE dead_lettered_at IS NOT NULL",
    );
    const pendingReferences = await this.database.query<Record<string, unknown> & { count: string }>(
      "SELECT count(*)::text AS count FROM wager_transactions WHERE status = 'PENDING_REFERENCE'",
    );
    const retryCounts = await this.database.query<Record<string, unknown> & { outbox: string; reference_attempts: string }>(
      `SELECT
         COALESCE((SELECT sum(attempts) FROM outbox_messages), 0)::text AS outbox,
         COALESCE((SELECT sum(reference_attempts) FROM wager_transactions), 0)::text AS reference_attempts`,
    );
    const lines = [
      "# HELP wagering_transactions_total Transactions by durable status",
      "# TYPE wagering_transactions_total gauge",
      ...rows.map((row) => `wagering_transactions_total{status="${row.status}"} ${row.count}`),
      "# HELP wagering_outbox_pending Number of events waiting for publication",
      "# TYPE wagering_outbox_pending gauge",
      `wagering_outbox_pending ${pending[0]?.count ?? "0"}`,
      "# HELP wagering_outbox_dead_lettered Number of events requiring operator review",
      "# TYPE wagering_outbox_dead_lettered gauge",
      `wagering_outbox_dead_lettered ${deadLettered[0]?.count ?? "0"}`,
      "# HELP wagering_outbox_lag_seconds Age of the oldest un-published integration event",
      "# TYPE wagering_outbox_lag_seconds gauge",
      `wagering_outbox_lag_seconds ${outboxLag[0]?.seconds ?? "0"}`,
      "# HELP wagering_pending_references Number of transactions waiting for a reference",
      "# TYPE wagering_pending_references gauge",
      `wagering_pending_references ${pendingReferences[0]?.count ?? "0"}`,
      "# HELP wagering_outbox_attempts_total Durable outbox publication attempts",
      "# TYPE wagering_outbox_attempts_total counter",
      `wagering_outbox_attempts_total ${retryCounts[0]?.outbox ?? "0"}`,
      "# HELP wagering_reference_attempts_total Durable pending-reference attempts",
      "# TYPE wagering_reference_attempts_total counter",
      `wagering_reference_attempts_total ${retryCounts[0]?.reference_attempts ?? "0"}`,
      ...this.processMetrics.render(),
    ];
    return `${lines.join("\n")}\n`;
  }
}
