import { EventEmitter } from 'node:events';
import type {
  AgentActivityEntry,
  AgentDetectionEntry,
  AgentsConfig,
  MaskConfig,
} from '../types/index.js';
import type { BaseInput } from '../inputs/base/base-input.js';
import type { BaseFlusher } from '../flushers/base-flusher.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { applyAgentContentPolicy } from '../normalization/agent-content-policy.js';
import { maskAgentActivityEntry } from '../mask/entry-masker.js';
import { loadMaskPlan } from '../mask/rule-loader.js';
import type { MaskPlan } from '../mask/types.js';
import type { TraceLinker } from './upstream-link/trace-linker.js';
import type { MultimodalProcessor } from '../multimodal/processor.js';
import { applyInvocationIdentity } from '../normalization/invocation-identity.js';

const logger = createLogger('InputManager');
const DROID_FORCED_MASK_CONFIG: MaskConfig = { mode: 'all', types: [] };
let droidForcedMaskPlan: MaskPlan | undefined;

export interface InputCounter {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
  type: string;
  lastActiveTime: number;
}

/**
 * Manages input lifecycles and routes produced entries to flushers.
 *
 * Responsibilities:
 *   1. Register / start / stop inputs
 *   2. Listen for 'entries' events from each input
 *   3. Enrich entries with user.id
 *   4. Forward to flusher(s) for output
 */
export class InputManager extends EventEmitter {
  private readonly inputs: Map<string, BaseInput> = new Map();
  private readonly counters: Map<string, InputCounter> = new Map();
  private readonly entryQueues: Map<string, Promise<void>> = new Map();
  private flusher: BaseFlusher | null = null;
  private alarmManager: AlarmManager | null = null;
  private userId: string = '';
  private configuredUserId: string = '';
  private agentsConfig: AgentsConfig = {};
  private maskConfig: MaskConfig = { mode: 'none', types: [] };
  private maskPlan: MaskPlan = { rules: [], piiTypes: new Set() };
  private traceLinker: TraceLinker | null = null;
  private multimodalProcessor: MultimodalProcessor | null = null;

  setFlusher(flusher: BaseFlusher): void {
    this.flusher = flusher;
  }

  setAlarmManager(alarmManager: AlarmManager): void {
    this.alarmManager = alarmManager;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setConfiguredUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  setAgentsConfig(config: AgentsConfig): void {
    this.agentsConfig = config;
  }

  setMaskConfig(config: MaskConfig): void {
    this.maskConfig = config;
    this.maskPlan = loadMaskPlan(config);
  }

  setTraceLinker(linker: TraceLinker): void {
    this.traceLinker = linker;
  }

  /** Process-scoped; reject replacing a different live instance. */
  setMultimodalProcessor(processor: MultimodalProcessor): void {
    if (this.multimodalProcessor && this.multimodalProcessor !== processor) {
      logger.warn('multimodal processor already set; ignoring replacement');
      return;
    }
    this.multimodalProcessor = processor;
  }

  registerInput(input: BaseInput): void {
    if (this.inputs.has(input.id)) {
      logger.warn('input already registered', { id: input.id });
      return;
    }
    this.inputs.set(input.id, input);
    this.counters.set(input.id, {
      inEvents: 0,
      inBytes: 0,
      outEvents: 0,
      outFailed: 0,
      lastPollTime: '',
      startTime: '',
      type: input.collectionMethod,
      lastActiveTime: 0,
    });
    // Structural test doubles and third-party embedders may still implement
    // the pre-1.3 EventEmitter-only shape. Production BaseInput instances use
    // the awaited sink; retain the event fallback for compatibility.
    if (typeof input.setEntrySink === 'function') {
      input.setEntrySink(entries => this.enqueueEntries(input.id, entries));
    }
    // Some inputs publish out-of-band batches from file watchers rather than
    // their collection cycle. Keep that compatibility path fail-open; regular
    // collect() cycles use the awaited sink above.
    input.on('entries', (entries: AgentActivityEntry[]) => {
      void this.enqueueEntries(input.id, entries).catch(err => {
        logger.error('entry handling failed', { inputId: input.id, error: String(err) });
      });
    });
    logger.info('input registered', { id: input.id });
  }

  private enqueueEntries(inputId: string, entries: AgentActivityEntry[]): Promise<void> {
    const previous = this.entryQueues.get(inputId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleEntries(inputId, entries));
    this.entryQueues.set(inputId, next);
    void next.finally(() => {
      if (this.entryQueues.get(inputId) === next) this.entryQueues.delete(inputId);
    }).catch(() => undefined);
    return next;
  }

  async startInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) {
      logger.warn('cannot start unknown input', { id });
      return;
    }
    await input.start();
    logger.info('input started', { id });
  }

  async stopInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) return;
    await input.stop();
    await this.drainInputQueue(id);
    logger.info('input stopped', { id });
  }

  async stopAll(): Promise<void> {
    for (const [id, input] of this.inputs) {
      if (input.running) {
        await input.stop();
      }
    }
    await this.drainAllEntryQueues();
    if (this.multimodalProcessor) {
      try {
        await this.multimodalProcessor.shutdown();
      } catch (err) {
        logger.warn('multimodal processor shutdown failed', { error: String(err) });
      }
      this.multimodalProcessor = null;
    }
  }

  private async drainInputQueue(id: string): Promise<void> {
    while (true) {
      const queue = this.entryQueues.get(id);
      if (!queue) return;
      await queue;
      if (this.entryQueues.get(id) === queue) {
        this.entryQueues.delete(id);
        return;
      }
    }
  }

  private async drainAllEntryQueues(): Promise<void> {
    while (this.entryQueues.size > 0) {
      await Promise.all([...this.entryQueues.keys()].map(id => this.drainInputQueue(id)));
    }
  }

  getInput(id: string): BaseInput | undefined {
    return this.inputs.get(id);
  }

  getInputCounters(): Map<string, InputCounter> {
    return this.counters;
  }

  getActiveInputIds(): string[] {
    return Array.from(this.inputs.entries())
      .filter(([, input]) => input.running)
      .map(([id]) => id);
  }

  getInputIdleMinutes(id: string): number {
    const counter = this.counters.get(id);
    if (!counter || counter.lastActiveTime === 0) return -1;
    return Math.floor((Date.now() - counter.lastActiveTime) / 60_000);
  }

  /**
   * Build a AgentDetectionEntry for use with AgentDiscoveryService.
   */
  buildDetectionEntry(
    input: BaseInput,
    opts: {
      watchPaths: string[];
      isAvailable: () => Promise<boolean>;
      enabled: () => boolean;
      pollIntervalMs?: number;
      unavailableThreshold?: number;
    },
  ): AgentDetectionEntry {
    return {
      id: input.id,
      type: input.collectionMethod,
      watchPaths: opts.watchPaths,
      isAvailable: opts.isAvailable,
      enabled: opts.enabled,
      start: () => this.startInput(input.id),
      stop: () => this.stopInput(input.id),
      pollIntervalMs: opts.pollIntervalMs ?? 300_000,
      ...(opts.unavailableThreshold != null ? { unavailableThreshold: opts.unavailableThreshold } : {}),
    };
  }

  private async handleEntries(
    inputId: string,
    entries: AgentActivityEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    const counter = this.counters.get(inputId);
    let batchBytes = 0;
    if (counter) {
      counter.inEvents += entries.length;
      for (const entry of entries) {
        const b = Buffer.byteLength(JSON.stringify(entry));
        counter.inBytes += b;
        batchBytes += b;
      }
      counter.lastPollTime = formatTime(new Date());
      counter.lastActiveTime = Date.now();
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    for (const entry of entries) {
      applyInvocationIdentity(entry, this.configuredUserId, this.userId);
    }

    // Upstream trace linking: stamp trace_id / parent_span_id from correlation
    // store so agent spans reparent under the upstream span. Fully fail-open.
    if (this.traceLinker) {
      try {
        // Droid IDs are the replay/idempotency contract. Reparenting would make
        // live and replay produce different trace IDs for the same source turn.
        const linkableEntries = entries.filter(
          entry => entry['gen_ai.agent.type'] !== 'droid',
        );
        if (linkableEntries.length > 0) await this.traceLinker.stamp(linkableEntries);
      } catch (err) {
        logger.warn('trace linker stamp failed (skipped)', { inputId, error: String(err) });
      }
    }

    const policyAppliedEntries = entries.map(entry =>
      applyAgentContentPolicy(entry, this.agentsConfig),
    );

    const maskedEntries = policyAppliedEntries.map(entry => {
      // Droid transcripts contain prompt/tool content read from local disk. If
      // that content is enabled, it must always pass the complete Pilot mask
      // plan even when the installation's global mask mode is less strict.
      // captureMessageContent=false was already applied above and leaves no
      // content fields to mask.
      if (entry['gen_ai.agent.type'] === 'droid') {
        droidForcedMaskPlan ??= loadMaskPlan(DROID_FORCED_MASK_CONFIG);
        return maskAgentActivityEntry(entry, DROID_FORCED_MASK_CONFIG, droidForcedMaskPlan);
      }
      if (this.maskPlan.rules.length === 0 && this.maskPlan.piiTypes.size === 0) return entry;
      return maskAgentActivityEntry(entry, this.maskConfig, this.maskPlan);
    });

    logger.info('dispatching entries', { inputId, count: maskedEntries.length });
    const requireLocalDurableAck = maskedEntries.some(
      entry => entry['gen_ai.agent.type'] === 'droid',
    );
    await this.dispatchEntries(inputId, maskedEntries, batchBytes, requireLocalDurableAck);
  }

  markInputStarted(id: string): void {
    const counter = this.counters.get(id);
    if (counter && !counter.startTime) {
      counter.startTime = formatTime(new Date());
    }
  }

  private async dispatchEntries(
    inputId: string,
    entries: AgentActivityEntry[],
    batchBytes: number,
    requireLocalDurableAck = false,
  ): Promise<void> {
    if (!this.flusher) {
      logger.warn('no flusher set, dropping entries', { count: entries.length });
      this.alarmManager?.record(
        'DISPATCH_DROP_ALARM', '3',
        `dropped ${entries.length} entries from ${inputId}: no flusher`,
        { input_name: inputId },
      );
      if (requireLocalDurableAck) {
        throw new Error('Droid collection requires a durable OTLP batch sink');
      }
      return;
    }

    const counter = this.counters.get(inputId);
    try {
      if (requireLocalDurableAck) {
        const durableFlusher = this.flusher as BaseFlusher & {
          sendBatchWithLocalDurableAck?: (batch: AgentActivityEntry[]) => Promise<void>;
        };
        if (typeof durableFlusher.sendBatchWithLocalDurableAck !== 'function') {
          throw new Error('Droid collection requires a durable OTLP batch sink');
        }
        await durableFlusher.sendBatchWithLocalDurableAck(entries);
      } else {
        await this.flusher.sendBatch(entries);
      }
      if (counter) counter.outEvents += entries.length;
      this.emit('flushed', { count: entries.length, bytes: batchBytes });
    } catch (err) {
      if (counter) counter.outFailed += entries.length;
      logger.error('dispatch failed', { count: entries.length, error: String(err) });
      if (requireLocalDurableAck) throw err;
    }
  }
}
