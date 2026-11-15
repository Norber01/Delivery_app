import type { DriverActionRequest, DriverActionResponse } from '@courier/shared-types';

/** Persistent key–value storage (AsyncStorage in the app, a Map in tests). */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface QueuedAction {
  request: DriverActionRequest;
  /** Local photo files still to upload; replaced by keys in `request.photoKeys` as they finish. */
  pendingPhotos: { uri: string; contentType: 'image/jpeg' }[];
  attempts: number;
  queuedAt: string;
  lastError: string | null;
}

export interface FailedAction {
  request: DriverActionRequest;
  code: string;
  message: string;
  failedAt: string;
}

export interface QueueSnapshot {
  pending: QueuedAction[];
  failed: FailedAction[];
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** True for network/server hiccups (retry later); false for business-rule rejections. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface QueueDeps {
  storage: KeyValueStorage;
  send: (req: DriverActionRequest) => Promise<DriverActionResponse>;
  uploadPhoto: (uri: string, deliveryId: string) => Promise<string>;
  now: () => Date;
}

const KEY = 'driver-action-queue:v1';
const MAX_FAILED = 30;

/**
 * Durable, ordered queue of driver actions (docs/06 §6.3 weak connectivity).
 * - Actions are stored before sending, so nothing is lost if the app is killed.
 * - Processed strictly in order: a later action never overtakes an earlier one.
 * - Retryable errors stop processing (try again later); business-rule errors are removed
 *   and kept in `failed` so the driver sees them.
 * - The server deduplicates by `actionId`, so re-sending after a lost response is safe.
 */
export class ActionQueue {
  private state: QueueSnapshot = { pending: [], failed: [] };
  private loaded = false;
  private running: Promise<void> | null = null;
  private listeners = new Set<(s: QueueSnapshot) => void>();

  constructor(private readonly deps: QueueDeps) {}

  subscribe(fn: (s: QueueSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): QueueSnapshot {
    return structuredClone(this.state);
  }

  private async load() {
    if (this.loaded) return;
    const raw = await this.deps.storage.getItem(KEY);
    if (raw) this.state = JSON.parse(raw) as QueueSnapshot;
    this.loaded = true;
  }

  private async save() {
    await this.deps.storage.setItem(KEY, JSON.stringify(this.state));
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  }

  /** Persist an action, then try to send it (and anything queued before it). */
  async enqueue(request: DriverActionRequest, photos: string[] = []): Promise<void> {
    await this.load();
    this.state.pending.push({
      request: { ...request, photoKeys: request.photoKeys ?? (photos.length ? [] : undefined) },
      pendingPhotos: photos.map((uri) => ({ uri, contentType: 'image/jpeg' })),
      attempts: 0,
      queuedAt: this.deps.now().toISOString(),
      lastError: null,
    });
    await this.save();
  }

  /**
   * Send queued actions in order. Returns the outcome for the given action id (if it was
   * processed in this run) so the UI can show an immediate result when online.
   */
  async process(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run() {
    await this.load();
    while (this.state.pending.length) {
      const item = this.state.pending[0]!;
      try {
        while (item.pendingPhotos.length) {
          const photo = item.pendingPhotos[0]!;
          const key = await this.deps.uploadPhoto(photo.uri, item.request.deliveryId);
          item.request.photoKeys = [...(item.request.photoKeys ?? []), key];
          item.pendingPhotos.shift();
          await this.save(); // never upload the same photo twice
        }
        await this.deps.send(item.request);
        this.state.pending.shift();
        await this.save();
      } catch (e) {
        const err = e instanceof ActionError ? e : new ActionError((e as Error).message ?? 'Unknown error', 'UNKNOWN', true);
        if (err.retryable) {
          item.attempts += 1;
          item.lastError = err.message;
          await this.save();
          return; // keep order; retry later
        }
        this.state.pending.shift();
        this.state.failed = [{ request: item.request, code: err.code, message: err.message, failedAt: this.deps.now().toISOString() }, ...this.state.failed].slice(0, MAX_FAILED);
        await this.save();
      }
    }
  }

  async dismissFailed(actionId: string) {
    await this.load();
    this.state.failed = this.state.failed.filter((f) => f.request.actionId !== actionId);
    await this.save();
  }
}

/** Callable error codes that are worth retrying. */
const RETRYABLE = new Set(['unavailable', 'deadline-exceeded', 'internal', 'resource-exhausted', 'aborted', 'unknown', 'UNKNOWN']);

/** Map a Firebase callable error to ActionError. */
export function toActionError(e: unknown): ActionError {
  const err = e as { code?: string; message?: string; details?: { code?: string } };
  const fnCode = (err.code ?? '').replace(/^functions\//, '');
  if (err.details?.code && !RETRYABLE.has(fnCode)) return new ActionError(err.message ?? 'Rejected', err.details.code, false);
  return new ActionError(err.message ?? 'Network error', err.details?.code ?? fnCode ?? 'UNKNOWN', true);
}
