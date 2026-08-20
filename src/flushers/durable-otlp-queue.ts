import { createHash, randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTraceState, type SpanContext } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { preparePrivateLocalWorkerDirectory } from '../local-workers/private-directory.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DurableOtlpQueue');

const MEBIBYTE = 1024 * 1024;
export const DEFAULT_DURABLE_OTLP_QUEUE_MAX_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_ITEM_BYTES = 64 * MEBIBYTE;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 65_000;
const FILESYSTEM_LOCK_ACQUIRE_TIMEOUT_MS = 5 * 60_000;
const FILESYSTEM_LOCK_OWNER_GRACE_MS = 5_000;
const FILESYSTEM_LOCK_POLL_MIN_MS = 10;
const FILESYSTEM_LOCK_POLL_MAX_MS = 50;
const QUEUE_SCHEMA_VERSION = 1;
const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const VALID_SPAN_ID_RE = /^[0-9a-f]{16}$/;

/**
 * The stock OTLP exporter only exposes ExportResult. Non-retryable HTTP
 * failures normally retain their numeric status as `error.code`, while the
 * exporter intentionally collapses exhausted retryable responses into a
 * generic error. Unknown failures therefore stay retryable; they are never
 * guessed into a permanent/DLQ class.
 */
export interface DurableOtlpQueueExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
}

export interface DurableOtlpQueueOptions {
  dataDir: string;
  /** Stable, non-secret route identity. Changing it intentionally orphans the old route. */
  routeId: string;
  /** Stable public endpoint identity (normalized URL + service + routing scope), never credentials. */
  endpointIdentity: string;
  /** Human-readable endpoint name used only in redacted operational logs. */
  endpointName: string;
  exporter: DurableOtlpQueueExporter;
  maxBytes?: number;
  maxItemBytes?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  sendTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  /** @internal Filesystem durability boundary used by fault-injection tests. */
  syncDirectory?: (directory: string) => Promise<void>;
}

export interface DurableOtlpQueueStatus {
  pendingItems: number;
  deadLetterItems: number;
  routeBytes: number;
  totalSpoolBytes: number;
  pausedHttpStatus?: number;
}

export interface DurableOtlpSpoolRouteInventory {
  routeDirectory: string;
  pendingItems: number;
  deadLetterItems: number;
  bytes: number;
}

export interface DurableOtlpSpoolInventory {
  schemaVersion: 1;
  totalBytes: number;
  routes: DurableOtlpSpoolRouteInventory[];
}

export class DurableOtlpQueueCapacityError extends Error {
  readonly code = 'DURABLE_OTLP_QUEUE_CAPACITY_EXCEEDED';

  constructor(readonly maxBytes: number, readonly currentBytes: number, readonly incomingBytes: number) {
    super(`durable OTLP queue capacity exceeded (${currentBytes} + ${incomingBytes} > ${maxBytes})`);
    this.name = 'DurableOtlpQueueCapacityError';
  }
}

interface SerializedSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
  traceState?: string;
}

interface SerializedLink {
  context: SerializedSpanContext;
  attributes?: Record<string, unknown>;
  droppedAttributesCount?: number;
}

interface SerializedEvent {
  name: string;
  time: [number, number];
  attributes?: Record<string, unknown>;
  droppedAttributesCount?: number;
}

interface SerializedSpan {
  name: string;
  kind: number;
  context: SerializedSpanContext;
  parentSpanId?: string;
  startTime: [number, number];
  endTime: [number, number];
  duration: [number, number];
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  links: SerializedLink[];
  events: SerializedEvent[];
  ended: boolean;
  resourceAttributes: Record<string, unknown>;
  instrumentationLibrary: { name: string; version?: string; schemaUrl?: string };
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
}

interface QueueEnvelope {
  schemaVersion: 1;
  id: string;
  routeId: string;
  endpointIdentityHash: string;
  endpointName: string;
  createdAt: number;
  spans: SerializedSpan[];
}

interface RouteManifest {
  schemaVersion: 1;
  routeId: string;
  endpointName: string;
  endpointIdentityHash: string;
}

interface QueueFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

interface FilesystemLockOwner {
  schemaVersion: 1;
  pid: number;
  createdAt: number;
  token: string;
}

const rootLocks = new Map<string, Promise<void>>();

/**
 * Endpoint-scoped, at-least-once OTLP spool.
 *
 * `export()` reports success after the complete ReadableSpan request has been
 * fsync'ed and atomically renamed into the queue. Network delivery happens in
 * the background. A crash after the backend accepts a request but before the
 * local unlink can produce a duplicate; stable trace/span ids make that
 * duplicate detectable downstream.
 */
export class DurableOtlpQueue implements DurableOtlpQueueExporter {
  private readonly storageRoot: string;
  private readonly routeDir: string;
  private readonly pendingDir: string;
  private readonly deadLetterDir: string;
  private readonly drainLockPath: string;
  private readonly endpointName: string;
  private readonly routeId: string;
  private readonly endpointIdentityHash: string;
  private readonly exporter: DurableOtlpQueueExporter;
  private readonly maxBytes: number;
  private readonly maxItemBytes: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sendTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly syncDirectory: (directory: string) => Promise<void>;
  private readonly ready: Promise<void>;

  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private pausedHttpStatus: number | undefined;
  private closed = false;

  constructor(options: DurableOtlpQueueOptions) {
    this.endpointName = options.endpointName;
    this.routeId = options.routeId;
    this.endpointIdentityHash = createHash('sha256').update(options.endpointIdentity).digest('hex');
    this.exporter = options.exporter;
    this.maxBytes = options.maxBytes ?? DEFAULT_DURABLE_OTLP_QUEUE_MAX_BYTES;
    this.maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;

    if (this.maxBytes <= 0 || this.maxItemBytes <= 0) {
      throw new Error('durable OTLP queue byte limits must be positive');
    }
    if (!this.routeId.trim()) throw new Error('durable OTLP queue routeId is required');
    if (!options.endpointIdentity.trim()) throw new Error('durable OTLP queue endpointIdentity is required');

    this.storageRoot = path.join(path.resolve(options.dataDir), 'spool', 'otlp', 'v1');
    const safeRoute = safeRouteDirectoryName(this.routeId);
    this.routeDir = path.join(this.storageRoot, 'routes', safeRoute);
    this.pendingDir = path.join(this.routeDir, 'pending');
    this.deadLetterDir = path.join(this.routeDir, 'dead-letter');
    this.drainLockPath = path.join(this.storageRoot, '.locks', `${safeRoute}.drain.lock`);
    this.ready = this.initialize();
    void this.ready.then(() => this.kickDrain()).catch((err) => {
      logger.error('durable OTLP queue initialization failed', {
        endpoint: this.endpointName,
        errorType: errorType(err),
      });
    });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('durable OTLP queue is shut down') });
      return;
    }

    let envelope: QueueEnvelope;
    let bytes: Buffer;
    try {
      ({ envelope, bytes } = this.serializeEnvelope(spans));
    } catch (err) {
      resultCallback({ code: ExportResultCode.FAILED, error: asError(err) });
      return;
    }

    void this.enqueue(envelope, bytes).then(() => {
      // This callback is a durable-local ack, not a backend-delivery ack.
      resultCallback({ code: ExportResultCode.SUCCESS });
      this.kickDrain();
    }, (err) => {
      logger.error('durable OTLP enqueue failed; existing queue was left intact', {
        endpoint: this.endpointName,
        errorType: errorType(err),
      });
      resultCallback({ code: ExportResultCode.FAILED, error: asError(err) });
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.ready.catch(() => undefined);
    await this.drainPromise?.catch(() => undefined);
    await this.exporter.shutdown();
  }

  /** Explicit recovery hook for future CLI/control-plane integration. */
  retryNow(): void {
    if (this.closed) return;
    this.pausedHttpStatus = undefined;
    this.retryAttempt = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.kickDrain();
  }

  /**
   * Runs one immediate replay pass and returns its resulting inventory. A
   * retryable failure remains pending (with the normal retry timer armed), so
   * callers must inspect `pendingItems` instead of treating resolution as a
   * remote-delivery guarantee.
   */
  async replayNow(): Promise<DurableOtlpQueueStatus> {
    // A caller can observe the exporter's callback before the active drain has
    // installed its retry timer. Let that pass finish first, then clear the
    // resulting pause/backoff and start a distinct immediate pass. Otherwise a
    // replay request racing a failed callback can be mistaken for the already
    // running pass and return with the item still pending.
    await this.ready;
    await this.drainPromise?.catch(() => undefined);
    this.retryNow();
    await this.waitForIdle();
    return this.inspect();
  }

  /** Test/diagnostic seam: waits only for current work, never for a future retry timer. */
  async waitForIdle(): Promise<void> {
    await this.ready;
    for (;;) {
      const activeDrain = this.drainPromise;
      if (activeDrain) {
        await activeDrain;
        continue;
      }
      // A retryable remote failure and an authentication pause intentionally
      // leave the item queued. Waiting for their future timer/operator action
      // would turn flush/shutdown into an unbounded block.
      if (this.closed || this.retryTimer || this.pausedHttpStatus !== undefined) return;
      // Recheck after every completed pass. In particular, the constructor's
      // startup pass may have captured an empty directory immediately before a
      // concurrent local enqueue was fsync-acked; its enqueue-side kick then
      // saw the still-active drainPromise and could not start a second pass.
      if (!await this.hasPendingItems()) return;
      this.kickDrain();
    }
  }

  async getStatus(): Promise<DurableOtlpQueueStatus> {
    await this.ready;
    const [pending, deadLetter, routeBytes, totalSpoolBytes] = await Promise.all([
      listRegularQueueFiles(this.pendingDir),
      listRegularQueueFiles(this.deadLetterDir),
      directoryBytes(this.routeDir),
      directoryBytes(this.storageRoot),
    ]);
    return {
      pendingItems: pending.filter(file => file.name.endsWith('.json')).length,
      deadLetterItems: deadLetter.length,
      routeBytes,
      totalSpoolBytes,
      pausedHttpStatus: this.pausedHttpStatus,
    };
  }

  inspect(): Promise<DurableOtlpQueueStatus> {
    return this.getStatus();
  }

  private async initialize(): Promise<void> {
    // Reuse the audited helper: 0700 on POSIX, protected owner/SYSTEM/Admin ACL
    // on Windows. Subdirectories/files inherit that protection and are also
    // explicitly hardened below.
    await preparePrivateLocalWorkerDirectory(this.storageRoot);
    await ensurePrivateDirectory(path.join(this.storageRoot, '.locks'));
    await ensurePrivateDirectory(path.join(this.storageRoot, 'routes'));
    await ensurePrivateDirectory(this.routeDir);
    await ensurePrivateDirectory(this.pendingDir);
    await ensurePrivateDirectory(this.deadLetterDir);
    await this.ensureRouteManifest();
    // Initialization recovery and normal draining share the same cross-process
    // route lock. A newly started CLI cannot move/replay a temp item while the
    // resident collector is already draining that route.
    await withFilesystemLock(this.drainLockPath, async () => {
      await this.recoverInterruptedEnqueues();
      await Promise.all([
        hardenRegularFiles(this.pendingDir),
        hardenRegularFiles(this.deadLetterDir),
      ]);
    });
  }

  private async ensureRouteManifest(): Promise<void> {
    const manifestPath = path.join(this.routeDir, 'manifest.json');
    const expected: RouteManifest = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      routeId: this.routeId,
      endpointName: this.endpointName,
      endpointIdentityHash: this.endpointIdentityHash,
    };
    const stat = await safeLstat(manifestPath);
    if (stat) {
      if (!stat.isFile() || stat.size > 64 * 1024) {
        throw new Error('durable OTLP route manifest is not a bounded regular file');
      }
      const actual = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<RouteManifest>;
      if (
        actual.schemaVersion !== expected.schemaVersion
        || actual.routeId !== expected.routeId
        || actual.endpointIdentityHash !== expected.endpointIdentityHash
      ) {
        throw new Error('durable OTLP route manifest identity mismatch');
      }
      await hardenFile(manifestPath);
      return;
    }

    const bytes = Buffer.from(`${JSON.stringify(expected)}\n`, 'utf8');
    let racedWithPeer = false;
    await withRootLock(this.storageRoot, async () => {
      // Another same-route initializer may have won while we waited.
      if (await safeLstat(manifestPath)) {
        racedWithPeer = true;
        return;
      }
      const currentBytes = await directoryBytes(this.storageRoot);
      if (currentBytes + bytes.length > this.maxBytes) {
        throw new DurableOtlpQueueCapacityError(this.maxBytes, currentBytes, bytes.length);
      }
      await writePrivateFileAtomic(manifestPath, bytes);
    });
    if (racedWithPeer) await this.ensureRouteManifest();
  }

  private serializeEnvelope(spans: ReadableSpan[]): { envelope: QueueEnvelope; bytes: Buffer } {
    if (spans.length === 0) throw new Error('cannot enqueue an empty OTLP span batch');
    const serializedSpans = spans.map(serializeSpan);
    const stablePayload = JSON.stringify(serializedSpans);
    const id = createHash('sha256').update(stablePayload).digest('hex');
    const envelope: QueueEnvelope = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      id,
      routeId: this.routeId,
      endpointIdentityHash: this.endpointIdentityHash,
      endpointName: this.endpointName,
      createdAt: this.now(),
      spans: serializedSpans,
    };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (bytes.length > this.maxItemBytes) {
      throw new Error(`durable OTLP queue item exceeds ${this.maxItemBytes} bytes`);
    }
    return { envelope, bytes };
  }

  private async enqueue(envelope: QueueEnvelope, bytes: Buffer): Promise<void> {
    await this.ready;
    await withRootLock(this.storageRoot, async () => {
      const finalPath = path.join(this.pendingDir, `${envelope.id}.json`);
      const deadLetterMatch = await findDeadLetterById(this.deadLetterDir, envelope.id);
      if (deadLetterMatch) {
        throw new Error(`durable OTLP item ${envelope.id} is already in dead-letter`);
      }
      const existing = await safeLstat(finalPath);
      if (existing?.isFile()) {
        const persisted = await this.readEnvelope({
          path: finalPath,
          name: path.basename(finalPath),
          size: existing.size,
          mtimeMs: existing.mtimeMs,
        });
        if (persisted.id !== envelope.id) {
          throw new Error('durable OTLP existing item id mismatch');
        }
        // A prior attempt may have completed rename(2) but failed the directory
        // fsync that makes the new entry a durable local acceptance. Re-assert
        // its identity and both protections before treating this deterministic
        // duplicate as ACKed.
        await hardenFile(finalPath);
        await this.syncDirectory(this.pendingDir);
        return;
      }
      if (existing) throw new Error(`durable OTLP queue target is not a regular file: ${finalPath}`);

      const currentBytes = await directoryBytes(this.storageRoot);
      if (currentBytes + bytes.length > this.maxBytes) {
        throw new DurableOtlpQueueCapacityError(this.maxBytes, currentBytes, bytes.length);
      }

      const tmpPath = path.join(
        this.pendingDir,
        `.${envelope.id}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
      );
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(tmpPath, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle?.close();
      }
      await hardenFile(tmpPath);
      await fs.rename(tmpPath, finalPath);
      await this.syncDirectory(this.pendingDir);
    });
  }

  private kickDrain(): void {
    if (this.closed || this.pausedHttpStatus !== undefined || this.retryTimer || this.drainPromise) return;
    const drain = this.ready.then(() => this.drainLoop());
    this.drainPromise = drain;
    void drain.catch((err) => {
      logger.error('durable OTLP drain failed; item remains queued', {
        endpoint: this.endpointName,
        errorType: errorType(err),
      });
      this.scheduleRetry();
    }).finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
      if (!this.closed && this.pausedHttpStatus === undefined && !this.retryTimer) {
        void this.hasPendingItems().then((hasPending) => {
          if (hasPending) this.kickDrain();
        }).catch(() => undefined);
      }
    });
  }

  private async drainLoop(): Promise<void> {
    await withFilesystemLock(this.drainLockPath, () => this.drainLoopWithRouteLock());
  }

  private async drainLoopWithRouteLock(): Promise<void> {
    while (!this.closed && this.pausedHttpStatus === undefined) {
      const file = await this.nextPendingFile();
      if (!file) return;

      let envelope: QueueEnvelope;
      let spans: ReadableSpan[];
      try {
        envelope = await this.readEnvelope(file);
        spans = restoreSpans(envelope.spans);
      } catch (err) {
        logger.error('invalid durable OTLP queue item moved to dead-letter', {
          endpoint: this.endpointName,
          errorType: errorType(err),
        });
        await this.moveToDeadLetter(file.path, path.basename(file.name, '.json'), 'corrupt');
        continue;
      }

      const result = await this.send(spans);
      if (result.code === ExportResultCode.SUCCESS) {
        await withRootLock(this.storageRoot, async () => {
          await fs.unlink(file.path);
          await syncDirectory(this.pendingDir);
        });
        this.retryAttempt = 0;
        continue;
      }

      const httpStatus = extractHttpStatus(result.error);
      if (httpStatus === 400) {
        await this.moveToDeadLetter(file.path, envelope.id, 'http-400');
        this.retryAttempt = 0;
        continue;
      }
      if (httpStatus === 401 || httpStatus === 403) {
        this.pausedHttpStatus = httpStatus;
        logger.error('durable OTLP route paused after authentication failure', {
          endpoint: this.endpointName,
          httpStatus,
        });
        return;
      }

      // Includes known 408/429/5xx, network errors, timeouts, and the generic
      // retryable error produced by the stock OpenTelemetry exporter.
      logger.warn('durable OTLP delivery failed; retry scheduled', {
        endpoint: this.endpointName,
        httpStatus,
        errorType: errorType(result.error),
      });
      // Custom exporters may preserve retryAfterMs/retryInMillis/headers. The
      // stock Node OTLP exporter currently drops Retry-After before invoking
      // ExportResult, so its generic retryable failures fall back to local
      // exponential backoff instead of pretending the server hint is known.
      this.scheduleRetry(extractRetryAfterMs(result.error, this.now()));
      return;
    }
  }

  private send(spans: ReadableSpan[]): Promise<ExportResult> {
    return new Promise<ExportResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ code: ExportResultCode.FAILED, error: new Error('durable OTLP exporter callback timeout') });
      }, this.sendTimeoutMs);
      timer.unref?.();

      try {
        this.exporter.export(spans, (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: ExportResultCode.FAILED, error: asError(err) });
      }
    });
  }

  private scheduleRetry(retryAfterMs?: number): void {
    if (this.closed || this.pausedHttpStatus !== undefined || this.retryTimer) return;
    const exponential = Math.min(
      this.retryBaseDelayMs * 2 ** Math.min(this.retryAttempt, 20),
      this.retryMaxDelayMs,
    );
    this.retryAttempt += 1;
    const delay = retryAfterMs !== undefined
      ? Math.max(1, Math.min(retryAfterMs, 24 * 60 * 60 * 1_000))
      : Math.max(1, Math.round(exponential * (0.5 + this.random() * 0.5)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kickDrain();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async nextPendingFile(): Promise<QueueFile | undefined> {
    const files = (await listRegularQueueFiles(this.pendingDir))
      .filter(file => file.name.endsWith('.json'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    return files[0];
  }

  private async hasPendingItems(): Promise<boolean> {
    return (await this.nextPendingFile()) !== undefined;
  }

  private async readEnvelope(file: QueueFile): Promise<QueueEnvelope> {
    if (file.size > this.maxItemBytes) throw new Error('queue item exceeds maximum item size');
    const raw = await fs.readFile(file.path, 'utf8');
    const value = JSON.parse(raw) as unknown;
    return validateEnvelope(value, this.routeId, this.endpointIdentityHash);
  }

  private async moveToDeadLetter(source: string, id: string, reason: string): Promise<void> {
    await withRootLock(this.storageRoot, async () => {
      const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'unknown';
      const safeReason = reason.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'unknown';
      let destination = path.join(this.deadLetterDir, `${safeId}.${safeReason}.json`);
      if (await safeLstat(destination)) {
        destination = path.join(
          this.deadLetterDir,
          `${safeId}.${safeReason}.${this.now()}.${randomBytes(4).toString('hex')}.json`,
        );
      }
      await fs.rename(source, destination);
      await hardenFile(destination);
      await Promise.all([syncDirectory(this.pendingDir), syncDirectory(this.deadLetterDir)]);
    });
  }

  private async recoverInterruptedEnqueues(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.pendingDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith('.tmp')) continue;
      const source = path.join(this.pendingDir, entry.name);
      if (!entry.isFile()) {
        logger.warn('refusing non-regular durable OTLP temp entry', { endpoint: this.endpointName });
        continue;
      }
      try {
        const stat = await fs.lstat(source);
        if (stat.size > this.maxItemBytes) throw new Error('temp item exceeds maximum item size');
        const value = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
        const envelope = validateEnvelope(value, this.routeId, this.endpointIdentityHash);
        const destination = path.join(this.pendingDir, `${envelope.id}.json`);
        if (await safeLstat(destination)) {
          await this.moveToDeadLetter(source, envelope.id, 'duplicate-temp');
        } else {
          await hardenFile(source);
          await fs.rename(source, destination);
          await syncDirectory(this.pendingDir);
        }
      } catch {
        const id = createHash('sha256').update(entry.name).digest('hex').slice(0, 24);
        await this.moveToDeadLetter(source, id, 'corrupt-temp');
      }
    }
  }
}

/** Read-only inventory used by `failed ... --dry-run`; it never opens payloads. */
export async function inspectDurableOtlpSpool(dataDir: string): Promise<DurableOtlpSpoolInventory> {
  const storageRoot = path.join(path.resolve(dataDir), 'spool', 'otlp', 'v1');
  const routesRoot = path.join(storageRoot, 'routes');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(routesRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: QUEUE_SCHEMA_VERSION, totalBytes: 0, routes: [] };
    }
    throw err;
  }

  const routes: DurableOtlpSpoolRouteInventory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // Refuse symlinks and other special files.
    const routeDir = path.join(routesRoot, entry.name);
    const [pending, deadLetter, bytes] = await Promise.all([
      listRegularQueueFiles(path.join(routeDir, 'pending')),
      listRegularQueueFiles(path.join(routeDir, 'dead-letter')),
      directoryBytes(routeDir),
    ]);
    routes.push({
      routeDirectory: entry.name,
      pendingItems: pending.filter(file => file.name.endsWith('.json')).length,
      deadLetterItems: deadLetter.length,
      bytes,
    });
  }
  routes.sort((a, b) => a.routeDirectory.localeCompare(b.routeDirectory));
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    totalBytes: await directoryBytes(storageRoot),
    routes,
  };
}

function serializeSpan(span: ReadableSpan): SerializedSpan {
  const context = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    context: serializeSpanContext(context),
    parentSpanId: span.parentSpanId,
    startTime: [...span.startTime] as [number, number],
    endTime: [...span.endTime] as [number, number],
    duration: [...span.duration] as [number, number],
    status: { ...span.status },
    attributes: { ...span.attributes },
    links: span.links.map(link => ({
      context: serializeSpanContext(link.context),
      attributes: link.attributes ? { ...link.attributes } : undefined,
      droppedAttributesCount: link.droppedAttributesCount,
    })),
    events: span.events.map(event => ({
      name: event.name,
      time: [...event.time] as [number, number],
      attributes: event.attributes ? { ...event.attributes } : undefined,
      droppedAttributesCount: event.droppedAttributesCount,
    })),
    ended: span.ended,
    resourceAttributes: { ...span.resource.attributes },
    instrumentationLibrary: { ...span.instrumentationLibrary },
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

function serializeSpanContext(context: SpanContext): SerializedSpanContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    isRemote: context.isRemote,
    traceState: context.traceState?.serialize(),
  };
}

function restoreSpans(serialized: SerializedSpan[]): ReadableSpan[] {
  const resources = new Map<string, Resource>();
  return serialized.map((span) => {
    validateSerializedSpan(span);
    const resourceKey = JSON.stringify(span.resourceAttributes);
    let resource = resources.get(resourceKey);
    if (!resource) {
      resource = new Resource(span.resourceAttributes as ConstructorParameters<typeof Resource>[0]);
      resources.set(resourceKey, resource);
    }
    return {
      name: span.name,
      kind: span.kind,
      spanContext: () => restoreSpanContext(span.context),
      parentSpanId: span.parentSpanId,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      status: span.status,
      attributes: span.attributes,
      links: span.links.map(link => ({
        context: restoreSpanContext(link.context),
        attributes: link.attributes,
        droppedAttributesCount: link.droppedAttributesCount,
      })),
      events: span.events,
      ended: span.ended,
      resource,
      instrumentationLibrary: span.instrumentationLibrary,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    } as ReadableSpan;
  });
}

function restoreSpanContext(context: SerializedSpanContext): SpanContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    isRemote: context.isRemote,
    traceState: context.traceState ? createTraceState(context.traceState) : undefined,
  };
}

function validateEnvelope(
  value: unknown,
  expectedRouteId: string,
  expectedEndpointIdentityHash: string,
): QueueEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('queue envelope is not an object');
  const envelope = value as Partial<QueueEnvelope>;
  if (envelope.schemaVersion !== QUEUE_SCHEMA_VERSION) throw new Error('unsupported queue schema version');
  if (typeof envelope.id !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.id)) throw new Error('invalid queue id');
  if (envelope.routeId !== expectedRouteId) throw new Error('queue route mismatch');
  if (envelope.endpointIdentityHash !== expectedEndpointIdentityHash) throw new Error('queue endpoint identity mismatch');
  if (typeof envelope.endpointName !== 'string') throw new Error('invalid endpoint name');
  if (!Number.isFinite(envelope.createdAt)) throw new Error('invalid queue timestamp');
  if (!Array.isArray(envelope.spans) || envelope.spans.length === 0) throw new Error('empty queue span batch');
  const payloadHash = createHash('sha256').update(JSON.stringify(envelope.spans)).digest('hex');
  if (payloadHash !== envelope.id) throw new Error('queue payload hash mismatch');
  return envelope as QueueEnvelope;
}

function validateSerializedSpan(span: SerializedSpan): void {
  if (!span || typeof span !== 'object') throw new Error('invalid serialized span');
  if (typeof span.name !== 'string') throw new Error('invalid span name');
  if (!VALID_TRACE_ID_RE.test(span.context?.traceId ?? '')) throw new Error('invalid trace id');
  if (!VALID_SPAN_ID_RE.test(span.context?.spanId ?? '')) throw new Error('invalid span id');
  if (span.parentSpanId !== undefined && !VALID_SPAN_ID_RE.test(span.parentSpanId)) throw new Error('invalid parent span id');
  for (const time of [span.startTime, span.endTime, span.duration]) {
    if (!Array.isArray(time) || time.length !== 2 || !time.every(Number.isFinite)) {
      throw new Error('invalid span time');
    }
  }
  if (!Array.isArray(span.events) || !Array.isArray(span.links)) throw new Error('invalid span events or links');
  if (!span.instrumentationLibrary || typeof span.instrumentationLibrary.name !== 'string') {
    throw new Error('invalid instrumentation library');
  }
}

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.code, candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown, nowMs: number): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    retryAfterMs?: unknown;
    retryInMillis?: unknown;
    headers?: Record<string, unknown>;
    response?: { headers?: Record<string, unknown> };
  };
  for (const value of [candidate.retryAfterMs, candidate.retryInMillis]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const headers = candidate.headers ?? candidate.response?.headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw * 1_000));
  if (typeof raw !== 'string') return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isInteger(seconds)) return Math.max(0, seconds * 1_000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function safeRouteDirectoryName(routeId: string): string {
  const base = routeId.normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48) || 'endpoint';
  const hash = createHash('sha256').update(routeId).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw new Error(`private queue path is not a directory: ${directory}`);
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}

async function writePrivateFileAtomic(target: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(target);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hardenFile(tmp);
    await fs.rename(tmp, target);
    await syncDirectory(directory);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function hardenRegularFiles(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(entries.filter(entry => entry.isFile()).map(entry => hardenFile(path.join(directory, entry.name))));
}

async function hardenFile(file: string): Promise<void> {
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeLstat(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function listRegularQueueFiles(directory: string): Promise<QueueFile[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: QueueFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // Never follow symlinks inside a telemetry spool.
    const filePath = path.join(directory, entry.name);
    const stat = await safeLstat(filePath);
    if (!stat?.isFile()) continue;
    files.push({ path: filePath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function directoryBytes(root: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await safeLstat(child))?.size ?? 0;
  }
  return total;
}

async function findDeadLetterById(directory: string, id: string): Promise<string | undefined> {
  const files = await listRegularQueueFiles(directory);
  return files.find(file => file.name.startsWith(`${id}.`))?.path;
}

async function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = rootLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  rootLocks.set(root, current);
  await previous.catch(() => undefined);
  try {
    return await withFilesystemLock(path.join(root, '.locks', 'root.lock'), operation);
  } finally {
    release();
    if (rootLocks.get(root) === current) rootLocks.delete(root);
  }
}

/**
 * Atomic mkdir-based process lock. The owner record contains no endpoint or
 * credential data. A dead PID (or an ownerless lock left before owner.json was
 * committed) is quarantined and removed; a live owner is never force-stolen.
 */
/**
 * Cross-process private lock shared with replay/checkpoint transactions.
 * The caller supplies a narrow lock-directory path; live PID ownership is
 * never stolen and dead owners are recovered through atomic quarantine.
 */
export async function withFilesystemLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = await acquireFilesystemLock(lockPath);
  try {
    return await operation();
  } finally {
    // Release failure is part of the operation's acceptance result. Reporting
    // success with a stuck live-PID lock would make later enqueues/replays hang.
    await releaseFilesystemLock(lockPath, owner);
  }
}

async function acquireFilesystemLock(lockPath: string): Promise<FilesystemLockOwner> {
  await ensurePrivateDirectory(path.dirname(lockPath));
  const owner: FilesystemLockOwner = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    pid: process.pid,
    createdAt: Date.now(),
    token: randomBytes(16).toString('hex'),
  };
  const deadline = Date.now() + FILESYSTEM_LOCK_ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      if (process.platform !== 'win32') await fs.chmod(lockPath, 0o700);
      try {
        await writePrivateFileAtomic(
          path.join(lockPath, 'owner.json'),
          Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8'),
        );
        return owner;
      } catch (err) {
        // We exclusively created this directory, so cleanup cannot remove a
        // peer's lock. A crash before this point is recovered by the grace rule.
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (await reclaimStaleFilesystemLock(lockPath, owner.token)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for durable OTLP filesystem lock: ${path.basename(lockPath)}`);
    }
    const spread = FILESYSTEM_LOCK_POLL_MAX_MS - FILESYSTEM_LOCK_POLL_MIN_MS;
    await delay(FILESYSTEM_LOCK_POLL_MIN_MS + Math.round(Math.random() * spread));
  }
}

async function reclaimStaleFilesystemLock(lockPath: string, contenderToken: string): Promise<boolean> {
  const stat = await safeLstat(lockPath);
  if (!stat) return true;
  if (!stat.isDirectory()) {
    throw new Error(`durable OTLP lock path is not a directory: ${lockPath}`);
  }

  const owner = await readFilesystemLockOwner(lockPath);
  if (owner) {
    if (isProcessAlive(owner.pid)) return false;
  } else if (Date.now() - stat.mtimeMs < FILESYSTEM_LOCK_OWNER_GRACE_MS) {
    // The winning process may be between mkdir and atomic owner.json rename.
    return false;
  }

  const quarantined = `${lockPath}.stale-${contenderToken}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(lockPath, quarantined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    throw err;
  }
  await fs.rm(quarantined, { recursive: true, force: true });
  return true;
}

async function releaseFilesystemLock(lockPath: string, owner: FilesystemLockOwner): Promise<void> {
  const actual = await readFilesystemLockOwner(lockPath);
  if (!actual) {
    if (await safeLstat(lockPath)) throw new Error('durable OTLP lock owner record is unreadable during release');
    return;
  }
  if (actual.token !== owner.token) return;

  const released = `${lockPath}.released-${owner.token}`;
  try {
    await fs.rename(lockPath, released);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await fs.rm(released, { recursive: true, force: true });
}

async function readFilesystemLockOwner(lockPath: string): Promise<FilesystemLockOwner | undefined> {
  const ownerPath = path.join(lockPath, 'owner.json');
  const stat = await safeLstat(ownerPath);
  if (!stat?.isFile() || stat.size > 4_096) return undefined;
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Partial<FilesystemLockOwner>;
    if (
      value.schemaVersion !== QUEUE_SCHEMA_VERSION
      || !Number.isInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || !Number.isFinite(value.createdAt)
      || typeof value.token !== 'string'
      || !/^[0-9a-f]{32}$/.test(value.token)
    ) return undefined;
    return value as FilesystemLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user. Only ESRCH
    // is proof that reclaiming cannot race a live queue owner.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
