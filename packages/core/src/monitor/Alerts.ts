import type { EventEmitter } from 'node:events';

export type AlertKind =
  | 'cache_hit'
  | 'error_rate'
  | 'corrupt'
  | 'backup_failed';

export interface AlertRule {
  kind: AlertKind;
  /** Fire when cache hit rate falls below this (0–1). */
  cacheHitBelow?: number;
  /** Fire when errors / (queries+writes+errors) exceeds this (0–1). */
  errorRateAbove?: number;
}

export interface AlertEvent {
  kind: AlertKind;
  message: string;
  ts: number;
  details?: Record<string, unknown>;
}

export interface AlertConfig {
  rules?: AlertRule[];
  /** Optional HTTP endpoint (POST JSON body). */
  webhookUrl?: string | null;
}

/**
 * Evaluates monitor signals and delivers alerts via EventEmitter + optional webhook.
 */
export class AlertManager {
  private readonly rules: AlertRule[];
  private readonly webhookUrl: string | null;
  private readonly seen = new Set<string>();
  private readonly history: AlertEvent[] = [];

  constructor(
    private readonly bus: EventEmitter,
    config?: AlertConfig,
  ) {
    this.rules = config?.rules ?? [];
    this.webhookUrl = config?.webhookUrl ?? null;
  }

  getHistory(): AlertEvent[] {
    return [...this.history];
  }

  async evaluateMetrics(input: {
    cacheHitRate: number;
    queriesTotal: number;
    writesTotal: number;
    errorsTotal: number;
  }): Promise<AlertEvent[]> {
    const out: AlertEvent[] = [];
    const denom =
      input.queriesTotal + input.writesTotal + input.errorsTotal || 1;
    const errorRate = input.errorsTotal / denom;
    for (const rule of this.rules) {
      if (
        rule.kind === 'cache_hit' &&
        rule.cacheHitBelow !== undefined &&
        input.cacheHitRate < rule.cacheHitBelow
      ) {
        const ev = await this.fire({
          kind: 'cache_hit',
          message: `cache hit rate ${input.cacheHitRate.toFixed(3)} below ${rule.cacheHitBelow}`,
          details: { cacheHitRate: input.cacheHitRate },
        });
        if (ev) out.push(ev);
      }
      if (
        rule.kind === 'error_rate' &&
        rule.errorRateAbove !== undefined &&
        errorRate >= rule.errorRateAbove
      ) {
        const ev = await this.fire({
          kind: 'error_rate',
          message: `error rate ${errorRate.toFixed(3)} at or above ${rule.errorRateAbove}`,
          details: { errorRate, errorsTotal: input.errorsTotal },
        });
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  async notifyCorrupt(
    message: string,
    details?: Record<string, unknown>,
  ): Promise<AlertEvent | null> {
    if (!this.rules.some((r) => r.kind === 'corrupt')) return null;
    return this.fire({ kind: 'corrupt', message, details });
  }

  async notifyBackupFailed(
    message: string,
    details?: Record<string, unknown>,
  ): Promise<AlertEvent | null> {
    // Backup failures always alert when any alert config exists, or when a backup_failed rule is set.
    if (
      this.rules.length > 0 &&
      !this.rules.some((r) => r.kind === 'backup_failed')
    ) {
      /* still allow explicit backup_failed rules only — but scheduled backup expects alerts */
    }
    return this.fire({ kind: 'backup_failed', message, details }, true);
  }

  private async fire(
    partial: Omit<AlertEvent, 'ts'> & { ts?: number },
    always = false,
  ): Promise<AlertEvent | null> {
    const key = `${partial.kind}:${partial.message}`;
    if (!always && this.seen.has(key)) return null;
    this.seen.add(key);
    const event: AlertEvent = {
      kind: partial.kind,
      message: partial.message,
      ts: partial.ts ?? Date.now(),
      ...(partial.details ? { details: partial.details } : {}),
    };
    this.history.push(event);
    this.bus.emit('alert', event);
    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        });
      } catch {
        /* webhook best-effort */
      }
    }
    return event;
  }
}
