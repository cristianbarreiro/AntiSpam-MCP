import type { ProviderSyncEvent } from "../../core/src/domain.js";

export const GMAIL_QUOTA_COST = {
  profile: 1,
  messagesList: 5,
  messagesGet: 20,
  historyList: 2,
  messagesTrash: 20,
} as const;

export interface GmailQuotaOptions {
  budgetPerMinute?: number;
  maximumBurst?: number;
  concurrency?: number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  observer?: (event: ProviderSyncEvent) => void;
}

export class GmailQuotaScheduler {
  private readonly budgetPerMinute: number;
  private readonly maximumBurst: number;
  private readonly concurrency: number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private observer?: (event: ProviderSyncEvent) => void;
  private tokens: number;
  private lastRefillAt: number;
  private cooldownUntil = 0;
  private activeRequests = 0;
  private queuedRequests = 0;
  private retryCount = 0;
  private lastRequestAt: number | undefined;
  private lastSuccessfulRequestAt: number | undefined;
  private readonly usage: Array<{ at: number; cost: number }> = [];
  private readonly slotWaiters: Array<() => void> = [];

  constructor(options: GmailQuotaOptions = {}) {
    this.budgetPerMinute = Math.max(1, options.budgetPerMinute ?? 2000);
    this.maximumBurst = Math.max(1, Math.min(this.budgetPerMinute, options.maximumBurst ?? 400));
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => Date.now());
    this.observer = options.observer;
    this.tokens = this.maximumBurst;
    this.lastRefillAt = this.now();
  }

  setObserver(observer: (event: ProviderSyncEvent) => void) {
    this.observer = observer;
  }

  private refill() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(
      this.maximumBurst,
      this.tokens + elapsed * (this.budgetPerMinute / 60000),
    );
    this.lastRefillAt = now;
    while (this.usage[0] && this.usage[0].at <= now - 60000) this.usage.shift();
  }

  metrics() {
    this.refill();
    const usedQuotaUnits = this.usage.reduce((total, item) => total + item.cost, 0);
    return {
      quotaBudget: this.budgetPerMinute,
      usedQuotaUnits,
      remainingQuotaUnits: Math.max(0, this.budgetPerMinute - usedQuotaUnits),
      queueLength: this.queuedRequests + this.slotWaiters.length,
      activeRequests: this.activeRequests,
      currentConcurrency: this.concurrency,
      retryCount: this.retryCount,
      ...(this.lastRequestAt ? { lastRequestAt: new Date(this.lastRequestAt).toISOString() } : {}),
      ...(this.lastSuccessfulRequestAt
        ? { lastSuccessfulRequestAt: new Date(this.lastSuccessfulRequestAt).toISOString() }
        : {}),
    };
  }

  private async acquireTokens(cost: number) {
    if (cost > this.maximumBurst)
      throw new Error("Gmail quota cost exceeds the configured maximum burst.");
    this.queuedRequests++;
    try {
      for (;;) {
        this.refill();
        const now = this.now();
        const tokenWait =
          this.tokens >= cost
            ? 0
            : Math.ceil(((cost - this.tokens) * 60000) / this.budgetPerMinute);
        const cooldownWait = Math.max(0, this.cooldownUntil - now);
        const wait = Math.max(tokenWait, cooldownWait);
        if (wait <= 0) {
          this.tokens -= cost;
          this.usage.push({ at: now, cost });
          return;
        }
        this.observer?.({
          type: "quota_wait",
          retryAt: new Date(now + wait).toISOString(),
          retryDelayMs: wait,
          metrics: this.metrics(),
        });
        await this.delay(wait);
      }
    } finally {
      this.queuedRequests--;
    }
  }

  private async acquireSlot() {
    if (this.activeRequests < this.concurrency) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.activeRequests++;
  }

  private releaseSlot() {
    this.activeRequests--;
    this.slotWaiters.shift()?.();
  }

  coolDown(milliseconds: number) {
    this.retryCount++;
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + milliseconds);
  }

  private async waitForCooldown() {
    for (;;) {
      const wait = Math.max(0, this.cooldownUntil - this.now());
      if (wait <= 0) return;
      this.observer?.({
        type: "quota_wait",
        retryAt: new Date(this.now() + wait).toISOString(),
        retryDelayMs: wait,
        metrics: this.metrics(),
      });
      await this.delay(wait);
    }
  }

  async schedule<T>(cost: number, request: () => Promise<T>): Promise<T> {
    await this.acquireTokens(cost);
    await this.acquireSlot();
    try {
      await this.waitForCooldown();
      this.lastRequestAt = this.now();
      const result = await request();
      this.lastSuccessfulRequestAt = this.now();
      this.observer?.({ type: "request_succeeded", metrics: this.metrics() });
      return result;
    } finally {
      this.releaseSlot();
    }
  }
}
