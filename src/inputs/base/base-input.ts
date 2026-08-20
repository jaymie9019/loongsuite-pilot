import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../checkpoints/state-store.js';

export interface InputOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;
}

export type InputEntrySink = (entries: AgentActivityEntry[]) => Promise<void>;

/**
 * Abstract base for every input.
 * Subclass one of the specialised bases (IdeInput, SqliteInput, etc.)
 * rather than this directly, unless you need a fully custom lifecycle.
 */
export abstract class BaseInput extends EventEmitter {
  abstract readonly id: string;
  abstract readonly agentType: ClientType;
  abstract readonly collectionMethod: CollectionMethod;

  protected readonly logger: BoundLogger;
  protected readonly stateStore: StateStore;
  protected pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cyclePromise: Promise<void> | null = null;
  private followUpRequested = false;
  private entrySink: InputEntrySink | null = null;
  private _running = false;

  constructor(opts: InputOptions) {
    super();
    this.stateStore = opts.stateStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.logger = createLogger(this.constructor.name);
  }

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.logger.info('starting');

    await this.onStart();
    await this.runCycle();

    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.followUpRequested = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cyclePromise;
    await this.onStop();
    this.logger.info('stopped');
  }

  /** Override to implement collection logic; return agent activity entries. */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  getAgentVersion?(): string;

  /** Optional hook called once on start. */
  protected async onStart(): Promise<void> {}
  /** Optional hook called once on stop. */
  protected async onStop(): Promise<void> {}

  /**
   * Stage checkpoint state only after the entry sink has accepted this cycle.
   * Inputs with an external durability contract can override this instead of
   * mutating StateStore during collect().
   */
  protected async beforeCheckpoint(): Promise<void> {}

  /** Cleanup source-side wakeups only after the checkpoint is on disk. */
  protected async afterCheckpoint(): Promise<void> {}

  /** Discard any state staged by collect() when dispatch/checkpoint fails. */
  protected async onCycleFailed(): Promise<void> {}

  /**
   * InputManager installs an awaited sink so a source checkpoint cannot race
   * ahead of downstream local acceptance. Direct EventEmitter consumers retain
   * the legacy fallback when no sink is configured.
   */
  setEntrySink(sink: InputEntrySink): void {
    this.entrySink = sink;
  }

  /** Request an immediate serialized collection cycle from an input-owned watcher. */
  protected requestCollection(): void {
    if (!this._running) return;
    if (this.cyclePromise) {
      this.followUpRequested = true;
      return;
    }
    void this.runCycle();
  }

  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runCycleOnce().finally(() => {
      this.cyclePromise = null;
      const shouldRunFollowUp = this._running && this.followUpRequested;
      this.followUpRequested = false;
      if (shouldRunFollowUp) {
        void this.runCycle();
      }
    });
    return this.cyclePromise;
  }

  private async runCycleOnce(): Promise<void> {
    try {
      const entries = await this.collect();
      if (entries.length > 0) {
        if (this.entrySink) await this.entrySink(entries);
        else this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      await this.beforeCheckpoint();
      await this.stateStore.save();
    } catch (err) {
      try {
        await this.onCycleFailed();
      } catch (cleanupErr) {
        this.logger.warn('failed to discard staged collection state', {
          error: String(cleanupErr),
        });
      }
      this.logger.error('collection cycle failed', { error: String(err) });
      this.emit('collect-error', err);
      return;
    }

    try {
      await this.afterCheckpoint();
    } catch (err) {
      // The checkpoint is already durable. Cleanup is retryable housekeeping
      // and must not roll back or re-emit an accepted source range.
      this.logger.warn('post-checkpoint cleanup failed', { error: String(err) });
    }
  }

  protected getState(): InputState {
    return this.stateStore.get(this.id);
  }

  protected setState(state: Partial<InputState>): void {
    this.stateStore.update(this.id, state);
  }
}
