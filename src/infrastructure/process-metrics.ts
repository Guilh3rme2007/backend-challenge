import { Injectable } from "@nestjs/common";

export type ProcessCounter =
  | "duplicates"
  | "retries"
  | "dlq"
  | "lockConflicts"
  | "outboxFailures"
  | "reconciliationMismatches";

@Injectable()
export class ProcessMetrics {
  private readonly counters = new Map<ProcessCounter, number>();
  private readonly durationBounds = [0.01, 0.05, 0.1, 0.5, 1, 5, 10];
  private readonly durationBuckets = new Map<number, number>();
  private processingCount = 0;
  private processingSeconds = 0;

  increment(name: ProcessCounter): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  observeProcessing(seconds: number): void {
    this.processingCount += 1;
    this.processingSeconds += seconds;
    for (const bound of this.durationBounds) {
      if (seconds <= bound) this.durationBuckets.set(bound, (this.durationBuckets.get(bound) ?? 0) + 1);
    }
  }

  render(): string[] {
    const names: Record<ProcessCounter, string> = {
      duplicates: "wagering_duplicates_detected_total",
      retries: "wagering_retries_total",
      dlq: "wagering_dlq_messages_total",
      lockConflicts: "wagering_lock_conflicts_total",
      outboxFailures: "wagering_outbox_publish_failures_total",
      reconciliationMismatches: "wagering_reconciliation_mismatches_total",
    };
    const lines: string[] = [];
    for (const [key, metricName] of Object.entries(names) as [ProcessCounter, string][]) {
      lines.push(`# HELP ${metricName} In-process operational counter`);
      lines.push(`# TYPE ${metricName} counter`);
      lines.push(`${metricName} ${this.counters.get(key) ?? 0}`);
    }
    lines.push("# HELP wagering_processing_duration_seconds Time spent in wagering submissions");
    lines.push("# TYPE wagering_processing_duration_seconds histogram");
    for (const bound of this.durationBounds) {
      lines.push(`wagering_processing_duration_seconds_bucket{le="${bound}"} ${this.durationBuckets.get(bound) ?? 0}`);
    }
    lines.push(
      `wagering_processing_duration_seconds_bucket{le="+Inf"} ${this.processingCount}`,
      `wagering_processing_duration_seconds_count ${this.processingCount}`,
      `wagering_processing_duration_seconds_sum ${this.processingSeconds.toFixed(6)}`,
    );
    return lines;
  }
}
