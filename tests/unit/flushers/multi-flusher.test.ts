import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('MultiFlusher', () => {
  let f1: MockFlusher;
  let f2: MockFlusher;
  let multi: MultiFlusher;

  beforeEach(() => {
    f1 = new MockFlusher('f1');
    f2 = new MockFlusher('f2');
    multi = new MultiFlusher([f1, f2]);
  });

  describe('sendBatch — parallel dispatch and fault isolation (T022)', () => {
    it('dispatches to all child flushers in parallel', async () => {
      const entries = [buildTestEntry(), buildTestEntry()];
      await multi.sendBatch(entries);

      expect(f1.batchCalls).toHaveLength(1);
      expect(f1.batchCalls[0]).toHaveLength(2);
      expect(f2.batchCalls).toHaveLength(1);
      expect(f2.batchCalls[0]).toHaveLength(2);
    });

    it('isolates failure — one fails, others still succeed', async () => {
      f1.shouldFail = true;
      const entries = [buildTestEntry()];
      await multi.sendBatch(entries);

      expect(f2.batchCalls).toHaveLength(1);
    });

    it('does not throw when one child fails', async () => {
      f2.shouldFail = true;
      await expect(multi.sendBatch([buildTestEntry()])).resolves.toBeUndefined();
    });
  });

  describe('local durable checkpoint acknowledgement', () => {
    it('rejects when any durable participant rejects', async () => {
      f1.shouldFail = true;
      await expect(multi.sendBatchWithLocalDurableAck([buildTestEntry()]))
        .rejects.toThrow('local durable batch acceptance failed');
      expect(f2.batchCalls).toHaveLength(1);
    });

    it('does not let an auxiliary backend failure veto a durable ACK', async () => {
      const auxiliary = {
        name: 'auxiliary',
        sendBatch: vi.fn(async () => { throw new Error('auxiliary unavailable'); }),
      };
      const mixed = new MultiFlusher([f1, auxiliary as any]);

      await expect(mixed.sendBatchWithLocalDurableAck([buildTestEntry()]))
        .resolves.toBeUndefined();
      expect(f1.batchCalls).toHaveLength(1);
      expect(auxiliary.sendBatch).toHaveBeenCalledOnce();
    });

    it('fails closed when no child provides durable acceptance', async () => {
      const auxiliary = {
        name: 'auxiliary',
        sendBatch: vi.fn(async () => undefined),
      };
      const withoutDurableRoute = new MultiFlusher([auxiliary as any]);

      await expect(withoutDurableRoute.sendBatchWithLocalDurableAck([buildTestEntry()]))
        .rejects.toThrow('no flusher provides local durable batch acceptance');
    });
  });

  describe('send — single entry dispatch', () => {
    it('dispatches single entry to all flushers', async () => {
      const entry = buildTestEntry();
      await multi.send(entry);

      expect(f1.sendCalls).toHaveLength(1);
      expect(f2.sendCalls).toHaveLength(1);
    });
  });

  describe('sendRaw forwarding (T023)', () => {
    it('forwards sendRaw to all child flushers', async () => {
      await multi.sendRaw('topic-x', { data: 'payload' });

      expect(f1.rawCalls).toHaveLength(1);
      expect(f1.rawCalls[0]).toEqual({ topic: 'topic-x', payload: { data: 'payload' } });
      expect(f2.rawCalls).toHaveLength(1);
    });

    it('isolates sendRaw failure', async () => {
      f1.shouldFail = true;
      await multi.sendRaw('topic', { x: 1 });
      expect(f2.rawCalls).toHaveLength(1);
    });
  });

  describe('shutdown (T024)', () => {
    it('shuts down all child flushers', async () => {
      await multi.shutdown();

      expect(f1.shutdownCount).toBe(1);
      expect(f2.shutdownCount).toBe(1);
    });

    it('isolates shutdown failure', async () => {
      f1.shouldFail = true;
      await multi.shutdown();
      expect(f2.shutdownCount).toBe(1);
    });
  });

  describe('flush', () => {
    it('flushes all child flushers', async () => {
      await multi.flush();
      expect(f1.flushCount).toBe(1);
      expect(f2.flushCount).toBe(1);
    });
  });
});
