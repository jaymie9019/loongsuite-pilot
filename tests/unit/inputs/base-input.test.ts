import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

class TestInput extends BaseInput {
  readonly id = 'test-input';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  collectFn: () => Promise<AgentActivityEntry[]> = async () => [];
  onStartFn: () => Promise<void> = async () => {};
  onStopFn: () => Promise<void> = async () => {};
  beforeCheckpointFn: () => Promise<void> = async () => {};
  afterCheckpointFn: () => Promise<void> = async () => {};
  onCycleFailedFn: () => Promise<void> = async () => {};

  protected async collect(): Promise<AgentActivityEntry[]> {
    return this.collectFn();
  }

  protected override async onStart(): Promise<void> {
    return this.onStartFn();
  }

  protected override async onStop(): Promise<void> {
    return this.onStopFn();
  }

  protected override async beforeCheckpoint(): Promise<void> {
    return this.beforeCheckpointFn();
  }

  protected override async afterCheckpoint(): Promise<void> {
    return this.afterCheckpointFn();
  }

  protected override async onCycleFailed(): Promise<void> {
    return this.onCycleFailedFn();
  }

  requestCollectionNow(): void {
    this.requestCollection();
  }
}

describe('BaseInput', () => {
  let stateStore: MockStateStore;
  let input: TestInput;

  beforeEach(() => {
    vi.useFakeTimers();
    stateStore = new MockStateStore();
    input = new TestInput({ stateStore: stateStore as any, pollIntervalMs: 5_000 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    vi.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('should set running to true after start', async () => {
      expect(input.running).toBe(false);
      await input.start();
      expect(input.running).toBe(true);
    });

    it('should set running to false after stop', async () => {
      await input.start();
      await input.stop();
      expect(input.running).toBe(false);
    });

    it('should call onStart during start', async () => {
      const spy = vi.fn();
      input.onStartFn = spy;
      await input.start();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should call onStop during stop', async () => {
      const spy = vi.fn();
      input.onStopFn = spy;
      await input.start();
      await input.stop();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should be idempotent on multiple start calls', async () => {
      const spy = vi.fn();
      input.onStartFn = spy;
      await input.start();
      await input.start();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should be idempotent on multiple stop calls', async () => {
      const spy = vi.fn();
      input.onStopFn = spy;
      await input.start();
      await input.stop();
      await input.stop();
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe('polling cycle', () => {
    it('should run collect immediately on start', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      expect(collectSpy).toHaveBeenCalledOnce();
    });

    it('should run collect on each poll interval', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      expect(collectSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(collectSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(collectSpy).toHaveBeenCalledTimes(3);
    });

    it('should stop polling after stop', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      await input.stop();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(collectSpy).toHaveBeenCalledTimes(1);
    });

    it('does not start another cycle while a slow collection is still running', async () => {
      await input.start();

      let release: (() => void) | undefined;
      const collectFn = vi.fn(() => new Promise<AgentActivityEntry[]>(resolve => {
        release = () => resolve([]);
      }));
      input.collectFn = collectFn;

      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();

      expect(collectFn).toHaveBeenCalledTimes(1);
      release?.();
      await Promise.resolve();
    });

    it('runs one coalesced follow-up when watcher requests arrive during a cycle', async () => {
      await input.start();

      let release!: () => void;
      const firstCycle = new Promise<void>(resolve => { release = resolve; });
      let cycleNumber = 0;
      const collectFn = vi.fn(async () => {
        cycleNumber++;
        if (cycleNumber === 1) await firstCycle;
        return [];
      });
      input.collectFn = collectFn;

      input.requestCollectionNow();
      await Promise.resolve();
      input.requestCollectionNow();
      input.requestCollectionNow();
      input.requestCollectionNow();

      expect(collectFn).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(collectFn).toHaveBeenCalledTimes(2);
    });

    it('does not start a requested follow-up after stop begins', async () => {
      await input.start();

      let release!: () => void;
      const activeCycle = new Promise<void>(resolve => { release = resolve; });
      let cycleNumber = 0;
      const collectFn = vi.fn(async () => {
        cycleNumber++;
        if (cycleNumber === 1) await activeCycle;
        return [];
      });
      input.collectFn = collectFn;

      input.requestCollectionNow();
      await Promise.resolve();
      input.requestCollectionNow();
      const stopping = input.stop();

      release();
      await stopping;
      await vi.advanceTimersByTimeAsync(0);

      expect(collectFn).toHaveBeenCalledTimes(1);
    });

    it('waits for an active collection before completing stop', async () => {
      await input.start();

      let release: (() => void) | undefined;
      input.collectFn = () => new Promise<AgentActivityEntry[]>(resolve => {
        release = () => resolve([]);
      });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      let stopped = false;
      const onStop = vi.fn();
      input.onStopFn = onStop;
      const stopping = input.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(onStop).not.toHaveBeenCalled();

      release?.();
      await stopping;
      expect(stopped).toBe(true);
      expect(onStop).toHaveBeenCalledOnce();
    });
  });

  describe('entries event emission', () => {
    it('should emit entries when collect returns non-empty array', async () => {
      const entries = [buildTestEntry()];
      input.collectFn = async () => entries;

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(entries);
    });

    it('should not emit entries when collect returns empty array', async () => {
      input.collectFn = async () => [];

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(0);
    });
  });

  describe('stateStore.save', () => {
    it('should call save after each cycle', async () => {
      input.collectFn = async () => [];
      await input.start();
      expect(stateStore.saveCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateStore.saveCount).toBe(2);
    });

    it('waits for the entry sink before committing a checkpoint', async () => {
      input.collectFn = async () => [buildTestEntry()];
      let release!: () => void;
      const accepted = new Promise<void>(resolve => { release = resolve; });
      const sink = vi.fn(() => accepted);
      const beforeCheckpoint = vi.fn();
      input.setEntrySink(sink);
      input.beforeCheckpointFn = async () => { beforeCheckpoint(); };

      const starting = input.start();
      for (let attempt = 0; attempt < 10 && sink.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      const sinkCallsBeforeAck = sink.mock.calls.length;
      const beforeCallsBeforeAck = beforeCheckpoint.mock.calls.length;
      const savesBeforeAck = stateStore.saveCount;

      release();
      await starting;
      expect(sinkCallsBeforeAck).toBe(1);
      expect(beforeCallsBeforeAck).toBe(0);
      expect(savesBeforeAck).toBe(0);
      expect(beforeCheckpoint).toHaveBeenCalledOnce();
      expect(stateStore.saveCount).toBe(1);
    });

    it('discards staged state and does not save when the entry sink rejects', async () => {
      input.collectFn = async () => [buildTestEntry()];
      input.setEntrySink(async () => { throw new Error('local durable queue full'); });
      const beforeCheckpoint = vi.fn();
      const afterCheckpoint = vi.fn();
      const failed = vi.fn();
      input.beforeCheckpointFn = async () => { beforeCheckpoint(); };
      input.afterCheckpointFn = async () => { afterCheckpoint(); };
      input.onCycleFailedFn = async () => { failed(); };

      await input.start();

      expect(beforeCheckpoint).not.toHaveBeenCalled();
      expect(afterCheckpoint).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(stateStore.saveCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should continue polling after collect throws', async () => {
      let callCount = 0;
      input.collectFn = async () => {
        callCount++;
        if (callCount === 1) throw new Error('test error');
        return [buildTestEntry()];
      };

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(emitted).toHaveLength(1);
    });
  });
});
