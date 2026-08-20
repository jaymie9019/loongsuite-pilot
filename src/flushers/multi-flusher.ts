import { BaseFlusher } from './base-flusher.js';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MultiFlusher');

/**
 * Fan-out flusher that dispatches to multiple downstream flushers in parallel.
 * Supports SLS + JSONL + HTTP simultaneously.
 */
export class MultiFlusher extends BaseFlusher {
  readonly name = 'multi';
  private readonly flushers: BaseFlusher[];

  constructor(flushers: BaseFlusher[]) {
    super();
    this.flushers = flushers;
  }

  getFlushers(): BaseFlusher[] {
    return this.flushers;
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const results = await Promise.allSettled(
      this.flushers.map(r => r.send(entry)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('flusher send failed', {
          flusher: this.flushers[i].name,
          error: String(err),
        });
      }
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    const results = await Promise.allSettled(
      this.flushers.map(r => r.sendBatch(entries)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('flusher sendBatch failed', {
          flusher: this.flushers[i].name,
          error: String(err),
        });
      }
    }
  }

  /**
   * Dispatches normally to auxiliary backends, but only a flusher exposing an
   * explicit local-durable ACK may authorize a Droid source checkpoint.
   */
  async sendBatchWithLocalDurableAck(entries: AgentActivityEntry[]): Promise<void> {
    let durableParticipants = 0;
    const durabilityFailures: unknown[] = [];
    const results = await Promise.allSettled(this.flushers.map(async flusher => {
      const candidate = flusher as BaseFlusher & {
        sendBatchWithLocalDurableAck?: (batch: AgentActivityEntry[]) => Promise<void>;
      };
      if (typeof candidate.sendBatchWithLocalDurableAck === 'function') {
        durableParticipants++;
        try {
          await candidate.sendBatchWithLocalDurableAck(entries);
        } catch (err) {
          durabilityFailures.push(err);
          throw err;
        }
        return;
      }
      await flusher.sendBatch(entries);
    }));

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        logger.error('flusher durable sendBatch failed', {
          flusher: this.flushers[i].name,
          error: String((results[i] as PromiseRejectedResult).reason),
        });
      }
    }
    if (durableParticipants === 0) {
      throw new Error('no flusher provides local durable batch acceptance');
    }
    if (durabilityFailures.length > 0) {
      throw new AggregateError(durabilityFailures, 'local durable batch acceptance failed');
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.shutdown()));
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    await Promise.allSettled(
      this.flushers.map(r => r.sendRaw(topic, payload)),
    );
  }
}
