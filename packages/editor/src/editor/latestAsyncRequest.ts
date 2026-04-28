export type LatestAsyncRequestOptions<T> = {
  readonly delayMs?: number;
  readonly run: () => Promise<T>;
  readonly apply: (result: T, startedAt: number) => void;
  readonly fail?: (error: unknown, startedAt: number) => void;
};

export class LatestAsyncRequest<T> {
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public schedule(options: LatestAsyncRequestOptions<T>): void {
    if (this.disposed) return;

    const requestId = this.nextRequestId();
    const delayMs = normalizeDelay(options.delayMs);
    if (delayMs === 0) {
      this.start(requestId, options);
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.start(requestId, options);
    }, delayMs);
  }

  public cancel(): void {
    this.requestId += 1;
    this.clearTimer();
  }

  public dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private nextRequestId(): number {
    this.cancel();
    return this.requestId;
  }

  private start(requestId: number, options: LatestAsyncRequestOptions<T>): void {
    if (!this.isCurrent(requestId)) return;

    const startedAt = nowMs();
    void options
      .run()
      .then((result) => this.apply(requestId, result, options, startedAt))
      .catch((error) => this.fail(requestId, error, options, startedAt));
  }

  private apply(
    requestId: number,
    result: T,
    options: LatestAsyncRequestOptions<T>,
    startedAt: number,
  ): void {
    if (!this.isCurrent(requestId)) return;
    options.apply(result, startedAt);
  }

  private fail(
    requestId: number,
    error: unknown,
    options: LatestAsyncRequestOptions<T>,
    startedAt: number,
  ): void {
    if (!this.isCurrent(requestId)) return;
    options.fail?.(error, startedAt);
  }

  private isCurrent(requestId: number): boolean {
    if (this.disposed) return false;
    return requestId === this.requestId;
  }

  private clearTimer(): void {
    if (this.timer === null) return;

    clearTimeout(this.timer);
    this.timer = null;
  }
}

const normalizeDelay = (delayMs: number | undefined): number => {
  if (!delayMs || delayMs <= 0) return 0;
  return delayMs;
};

const nowMs = (): number => globalThis.performance?.now() ?? Date.now();
