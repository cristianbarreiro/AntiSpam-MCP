import { randomUUID } from "node:crypto";
import { aggregate } from "./aggregation.js";
import { classifyMessage } from "./classification.js";
import type {
  Classification,
  DashboardJobStatus,
  DashboardSnapshot,
  MailAccount,
  MailboxNoiseReport,
  MailboxScanResult,
  MailMessage,
  MailProvider,
  MailSyncPage,
  MailSyncState,
  ProviderSyncEvent,
  SenderGroup,
} from "./domain.js";
import { AppError, safeError } from "./errors.js";
import { normalizeAddress } from "./sender.js";
import type { Store } from "./store.js";
export class MailboxService {
  private cache:
    | { messages: MailMessage[]; summary: MailboxScanResult; expires: number }
    | undefined;
  private cursors = new Map<string, { sender: string; provider: string; expires: number }>();
  private dashboardSnapshotValue: DashboardSnapshot | undefined;
  private dashboardJob: Promise<DashboardSnapshot> | undefined;
  private dashboardStatusValue: DashboardJobStatus;
  private activeSyncState: MailSyncState | undefined;
  private readonly syncOwner = randomUUID();
  private syncLeaseHeld = false;
  constructor(
    readonly provider: MailProvider,
    readonly store: Store,
    readonly account: MailAccount,
    private readonly now = () => Date.now(),
  ) {
    const timestamp = new Date(this.now()).toISOString();
    this.dashboardStatusValue = {
      jobId: randomUUID(),
      accountKey: account.id,
      scopeKey: "max:1000",
      stage: "idle",
      processed: 0,
      total: null,
      percent: null,
      coverage: "unknown",
      ready: false,
      source: "none",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.provider.setSyncObserver?.((event) => this.onProviderSyncEvent(event));
  }
  assertAccount(m: MailMessage) {
    if (m.accountId !== this.account.id) throw new AppError("PERMISSION_DENIED");
  }
  async collect(
    max: number,
    sender?: string,
    onProgress?: (processed: number, total: number | null) => void,
  ) {
    const messages = new Map<string, MailMessage>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.provider.scanMessages({
        limit: Math.min(100, max - messages.size),
        ...(cursor ? { cursor } : {}),
        ...(sender ? { sender } : {}),
      });
      for (const m of page.items) {
        this.assertAccount(m);
        if (!m.trashed && (!sender || m.sender.email === sender)) messages.set(m.id, m);
      }
      onProgress?.(messages.size, null);
      if (messages.size > max) throw new AppError("PROVIDER_ERROR");
      if (!page.cursor) return { messages: [...messages.values()], complete: true };
      if (messages.size >= max) return { messages: [...messages.values()], complete: false };
      if (seen.has(page.cursor)) throw new AppError("PROVIDER_ERROR");
      seen.add(page.cursor);
      cursor = page.cursor;
    }
    return { messages: [...messages.values()], complete: false };
  }
  private groups(messages: MailMessage[]) {
    return aggregate(messages, (a, s) => this.store.policy(a, s)?.detectionEnabled ?? true);
  }
  private updateDashboardStatus(update: Partial<DashboardJobStatus>) {
    this.dashboardStatusValue = {
      ...this.dashboardStatusValue,
      ...update,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
  private onProviderSyncEvent(event: ProviderSyncEvent) {
    if (!this.dashboardJob && !this.activeSyncState) return;
    if (event.type === "quota_wait" || event.type === "rate_limited") {
      this.updateDashboardStatus({
        stage: "cooling_down",
        retryAt: event.retryAt,
        quota: event.metrics,
      });
      if (this.activeSyncState) {
        this.activeSyncState = {
          ...this.activeSyncState,
          status: "cooling_down",
          retryAt: event.retryAt,
          updatedAt: new Date(this.now()).toISOString(),
        };
        this.store.saveSyncPage(this.activeSyncState, [], []);
      }
      return;
    }
    if (event.type === "retrying") {
      this.updateDashboardStatus({
        stage: "retrying",
        retryAt: event.retryAt,
        quota: event.metrics,
      });
      return;
    }
    if (this.activeSyncState?.status === "cooling_down") {
      this.activeSyncState = {
        ...this.activeSyncState,
        status: "syncing",
        retryAt: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.store.saveSyncPage(this.activeSyncState, [], []);
      this.updateDashboardStatus({
        stage: this.activeSyncState.mode === "incremental" ? "incremental_sync" : "syncing",
        retryAt: undefined,
        quota: event.metrics,
      });
    } else if (event.metrics) {
      this.updateDashboardStatus({ quota: event.metrics });
    }
  }
  dashboardStatus(): DashboardJobStatus {
    if (
      !this.dashboardJob &&
      ["discovering", "syncing", "incremental_sync", "cooling_down", "retrying"].includes(
        this.dashboardStatusValue.stage,
      )
    ) {
      const state = this.store.syncState(this.account.id);
      if (state && state.updatedAt > this.dashboardStatusValue.updatedAt) {
        const snapshot = this.store.dashboardSnapshot(
          this.account.id,
          this.dashboardStatusValue.scopeKey,
        );
        if (snapshot) this.restoreSnapshot(snapshot);
        this.updateDashboardStatus({
          stage:
            state.status === "completed" || state.status === "idle"
              ? "ready"
              : state.status === "failed"
                ? "error"
                : state.status === "cooling_down"
                  ? "cooling_down"
                  : state.mode === "incremental"
                    ? "incremental_sync"
                    : "syncing",
          processed: state.processedCount,
          total: state.estimatedTotal ?? null,
          estimatedTotal: state.estimatedTotal,
          retryAt: state.retryAt,
          syncMode: state.mode,
          ready: Boolean(snapshot),
          source: snapshot ? "live" : "none",
          ...(state.status === "failed"
            ? {
                error: {
                  code: state.lastError ?? "PROVIDER_ERROR",
                  message: "The provider could not complete the request. Refresh before retrying.",
                  retryable: true,
                },
              }
            : {}),
        });
      }
    }
    return structuredClone(this.dashboardStatusValue);
  }
  dashboardSnapshot(): DashboardSnapshot {
    if (!this.dashboardSnapshotValue) throw new AppError("SCAN_REQUIRED");
    return structuredClone(this.dashboardSnapshotValue);
  }
  private buildSnapshot(
    messages: MailMessage[],
    summary: MailboxScanResult,
    scopeKey: string,
  ): DashboardSnapshot {
    const previousCache = this.cache;
    this.cache = { messages, summary, expires: this.now() + 300000 };
    const snapshot: DashboardSnapshot = {
      schemaVersion: 1,
      datasetVersion: randomUUID(),
      accountId: this.account.id,
      scopeKey,
      requestedLimit: summary.requestedLimit,
      generatedAt: summary.generatedAt,
      scan: summary,
      groups: this.groups(messages),
      reports: {
        "7": this.noiseReport(7, 100),
        "30": this.noiseReport(30, 100),
        "90": this.noiseReport(90, 100),
      },
      messages: messages.map((message) => ({
        id: message.id,
        sender: message.sender,
        subject: message.subject,
        date: message.date,
        unread: message.unread,
        signals: message.signals,
        classification: classifyMessage(message),
      })),
    };
    this.cache = previousCache;
    return snapshot;
  }
  private restoreSnapshot(snapshot: DashboardSnapshot) {
    const messages: MailMessage[] = snapshot.messages.map((message) => {
      return {
        id: message.id,
        accountId: snapshot.accountId,
        sender: message.sender,
        subject: message.subject,
        date: message.date,
        unread: message.unread,
        trashed: false,
        signals: message.signals,
      };
    });
    this.cache = { messages, summary: snapshot.scan, expires: this.now() + 300000 };
    this.dashboardSnapshotValue = snapshot;
  }
  private summary(messages: MailMessage[], maxMessages: number, complete: boolean) {
    const groups = this.groups(messages);
    const classificationSummary: MailboxScanResult["classificationSummary"] = {};
    for (const group of groups)
      classificationSummary[group.classification.classification] =
        (classificationSummary[group.classification.classification] ?? 0) + 1;
    const summary: MailboxScanResult = {
      requestedLimit: maxMessages,
      scannedMessages: messages.length,
      senderCount: groups.length,
      complete,
      generatedAt: new Date(this.now()).toISOString(),
      classificationSummary,
    };
    return summary;
  }
  private publishSyncedSnapshot(
    messages: MailMessage[],
    maxMessages: number,
    complete: boolean,
    scopeKey: string,
  ) {
    const summary = this.summary(messages, maxMessages, complete);
    const snapshot = this.buildSnapshot(messages, summary, scopeKey);
    this.store.saveDashboardSnapshot(snapshot);
    this.cache = { messages, summary, expires: this.now() + 300000 };
    this.dashboardSnapshotValue = snapshot;
    this.updateDashboardStatus({
      datasetVersion: snapshot.datasetVersion,
      processed: this.activeSyncState?.processedCount ?? messages.length,
      total: this.activeSyncState?.estimatedTotal ?? null,
      estimatedTotal: this.activeSyncState?.estimatedTotal,
      coverage: complete ? "complete" : "partial",
      ready: true,
      source: "live",
    });
    return snapshot;
  }
  private newFullSyncState(): MailSyncState {
    return {
      accountId: this.account.id,
      mode: "full",
      status: "syncing",
      generation: randomUUID(),
      processedCount: 0,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
  private async prepareSynchronizedDashboard(maxMessages: number, scopeKey: string) {
    const syncPage = this.provider.syncPage;
    const currentHistoryId = this.provider.currentHistoryId;
    if (!syncPage || !currentHistoryId) throw new AppError("INTERNAL_ERROR");
    let state = this.store.syncState(this.account.id);
    const pausedFullProcessed =
      state?.mode === "full" && state.status === "idle" ? state.processedCount : undefined;
    if (!state || (state.status === "completed" && !state.lastHistoryId))
      state = this.newFullSyncState();
    else if (state.status === "completed" && state.lastHistoryId)
      state = {
        ...state,
        mode: "incremental",
        status: "syncing",
        nextPageToken: undefined,
        historyStartId: state.lastHistoryId,
        processedCount: 0,
        estimatedTotal: undefined,
        lastError: undefined,
        retryAt: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
    else
      state = {
        ...state,
        status: "syncing",
        lastError: undefined,
        retryAt: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
    if (state.mode === "full" && !state.lastHistoryId)
      state.lastHistoryId = await currentHistoryId.call(this.provider);
    const fullTarget = Math.min(
      10000,
      pausedFullProcessed === undefined
        ? Math.max(maxMessages, state.processedCount)
        : Math.max(maxMessages, pausedFullProcessed + maxMessages),
    );
    if (state.mode === "full" && state.processedCount >= fullTarget)
      state = {
        ...state,
        status: "idle",
        updatedAt: new Date(this.now()).toISOString(),
      };
    this.activeSyncState = state;
    this.store.saveSyncPage(state, [], []);
    this.provider.recordSyncEvent?.(
      state.mode === "incremental" ? "incremental_sync_started" : "sync_started",
      {
        syncType: state.mode,
        processed: state.processedCount,
        estimatedTotal: state.estimatedTotal,
      },
    );
    this.updateDashboardStatus({
      stage: state.mode === "incremental" ? "incremental_sync" : "discovering",
      syncMode: state.mode,
      processed: state.processedCount,
      total: state.estimatedTotal ?? null,
      estimatedTotal: state.estimatedTotal,
      percent: null,
      error: undefined,
    });
    let publishedAt = this.dashboardSnapshotValue ? state.processedCount : 0;
    let restartedFullSync = false;
    for (
      let pages = 0;
      pages < 1000 && (state.mode === "incremental" || state.processedCount < fullTarget);
      pages++
    ) {
      this.store.renewSyncLease(
        this.account.id,
        this.syncOwner,
        new Date(this.now() + 300000).toISOString(),
      );
      let page: MailSyncPage;
      try {
        page = await syncPage.call(this.provider, {
          mode: state.mode,
          ...(state.nextPageToken ? { pageToken: state.nextPageToken } : {}),
          ...(state.mode === "incremental"
            ? { historyId: state.historyStartId ?? state.lastHistoryId }
            : {}),
          limit: Math.min(100, Math.max(1, fullTarget - state.processedCount)),
        });
      } catch (error) {
        if (
          state.mode === "incremental" &&
          error instanceof AppError &&
          error.code === "NOT_FOUND" &&
          !restartedFullSync
        ) {
          restartedFullSync = true;
          state = this.newFullSyncState();
          state.lastHistoryId = await currentHistoryId.call(this.provider);
          this.activeSyncState = state;
          this.store.saveSyncPage(state, [], []);
          this.updateDashboardStatus({
            stage: "discovering",
            syncMode: "full",
            processed: 0,
            total: null,
            estimatedTotal: undefined,
          });
          continue;
        }
        if (
          state.mode === "full" &&
          state.nextPageToken &&
          error instanceof AppError &&
          error.code === "VALIDATION_ERROR" &&
          !restartedFullSync
        ) {
          restartedFullSync = true;
          state = this.newFullSyncState();
          state.lastHistoryId = await currentHistoryId.call(this.provider);
          this.activeSyncState = state;
          this.store.saveSyncPage(state, [], []);
          this.updateDashboardStatus({
            stage: "discovering",
            syncMode: "full",
            processed: 0,
            total: null,
            estimatedTotal: undefined,
          });
          continue;
        }
        throw error;
      }
      const complete: boolean = !page.nextPageToken;
      const processedCount: number = state.processedCount + page.processed;
      state = {
        ...state,
        status: complete ? "completed" : "syncing",
        nextPageToken: page.nextPageToken,
        processedCount,
        estimatedTotal: page.estimatedTotal ?? state.estimatedTotal,
        lastProcessedMessageId: page.upserts.at(-1)?.id ?? state.lastProcessedMessageId,
        lastHistoryId:
          state.mode === "incremental" && complete
            ? (page.historyId ?? state.lastHistoryId)
            : state.lastHistoryId,
        historyStartId: state.mode === "incremental" && complete ? undefined : state.historyStartId,
        lastSuccessfulSyncAt: complete
          ? new Date(this.now()).toISOString()
          : state.lastSuccessfulSyncAt,
        lastError: undefined,
        retryAt: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.activeSyncState = state;
      this.store.saveSyncPage(state, page.upserts, page.deletedIds);
      this.provider.recordSyncEvent?.("checkpoint_saved", {
        syncType: state.mode,
        processed: state.processedCount,
        estimatedTotal: state.estimatedTotal,
      });
      this.updateDashboardStatus({
        stage: state.mode === "incremental" ? "incremental_sync" : "syncing",
        syncMode: state.mode,
        processed: state.processedCount,
        total: state.estimatedTotal ?? null,
        estimatedTotal: state.estimatedTotal,
        percent:
          state.estimatedTotal && state.estimatedTotal > 0
            ? Math.min(99, Math.round((state.processedCount / state.estimatedTotal) * 100))
            : null,
        retryAt: undefined,
      });
      const shouldPublish =
        complete ||
        (state.mode === "full" &&
          state.processedCount >= 200 &&
          (!this.dashboardSnapshotValue || state.processedCount - publishedAt >= 500));
      if (shouldPublish) {
        const messages = this.store.syncMessages(this.account.id, maxMessages);
        this.publishSyncedSnapshot(messages, maxMessages, complete, scopeKey);
        publishedAt = state.processedCount;
      }
      if (complete) break;
      if (state.mode === "full" && state.processedCount >= fullTarget) {
        state = {
          ...state,
          status: "idle",
          updatedAt: new Date(this.now()).toISOString(),
        };
        this.activeSyncState = state;
        this.store.saveSyncPage(state, [], []);
        break;
      }
    }
    const complete = state.status === "completed";
    const messages = this.store.syncMessages(this.account.id, maxMessages);
    const snapshot = this.publishSyncedSnapshot(messages, maxMessages, complete, scopeKey);
    this.store.audit(this.account.id, "SCAN_COMPLETED", {
      count: messages.length,
      result: complete ? (state.mode === "incremental" ? "INCREMENTAL" : "COMPLETE") : "PARTIAL",
    });
    this.provider.recordSyncEvent?.(
      state.mode === "incremental" ? "incremental_sync_completed" : "full_sync_completed",
      {
        syncType: state.mode,
        processed: state.processedCount,
        estimatedTotal: state.estimatedTotal,
        complete,
      },
    );
    this.updateDashboardStatus({
      stage: "ready",
      processed: state.processedCount,
      total: state.estimatedTotal ?? messages.length,
      percent: complete ? 100 : null,
      coverage: complete ? "complete" : "partial",
      ready: true,
      source: "live",
      retryAt: undefined,
      error: undefined,
    });
    this.activeSyncState = undefined;
    return snapshot;
  }
  private async prepareDashboard(maxMessages: number, scopeKey: string) {
    this.updateDashboardStatus({
      stage: this.dashboardSnapshotValue ? "refreshing" : "connecting",
      processed: 0,
      total: null,
      percent: this.dashboardSnapshotValue ? null : 5,
    });
    this.updateDashboardStatus({ stage: "fetching", percent: null });
    if (this.provider.syncPage && this.provider.currentHistoryId)
      return this.prepareSynchronizedDashboard(maxMessages, scopeKey);
    const { messages, complete } = await this.collect(maxMessages, undefined, (processed) =>
      this.updateDashboardStatus({ processed }),
    );
    this.updateDashboardStatus({
      stage: "processing",
      processed: messages.length,
      total: messages.length,
      percent: 58,
    });
    const groups = this.groups(messages);
    this.updateDashboardStatus({ stage: "classifying", percent: 72 });
    const classificationSummary: MailboxScanResult["classificationSummary"] = {};
    for (const group of groups)
      classificationSummary[group.classification.classification] =
        (classificationSummary[group.classification.classification] ?? 0) + 1;
    const summary: MailboxScanResult = {
      requestedLimit: maxMessages,
      scannedMessages: messages.length,
      senderCount: groups.length,
      complete,
      generatedAt: new Date(this.now()).toISOString(),
      classificationSummary,
    };
    this.updateDashboardStatus({ stage: "preparing_view", percent: 86 });
    const snapshot = this.buildSnapshot(messages, summary, scopeKey);
    this.updateDashboardStatus({ stage: "persisting", percent: 94 });
    this.store.saveDashboardSnapshot(snapshot);
    this.store.audit(this.account.id, "SCAN_COMPLETED", {
      count: messages.length,
      result: complete ? "COMPLETE" : "PARTIAL",
    });
    this.cache = { messages, summary, expires: this.now() + 300000 };
    this.dashboardSnapshotValue = snapshot;
    this.updateDashboardStatus({
      datasetVersion: snapshot.datasetVersion,
      stage: "ready",
      processed: messages.length,
      total: messages.length,
      percent: 100,
      coverage: complete ? "complete" : "partial",
      ready: true,
      source: "live",
      error: undefined,
    });
    return snapshot;
  }
  startDashboardInitialization(maxMessages = 1000, force = false): DashboardJobStatus {
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000)
      throw new AppError("VALIDATION_ERROR");
    const scopeKey = `max:${maxMessages}`;
    if (this.dashboardJob) {
      if (this.dashboardStatusValue.scopeKey === scopeKey) return this.dashboardStatus();
      throw new AppError("VALIDATION_ERROR");
    }
    if (!force) {
      const cached =
        this.dashboardSnapshotValue?.scopeKey === scopeKey
          ? this.dashboardSnapshotValue
          : this.store.dashboardSnapshot(this.account.id, scopeKey);
      if (cached) {
        this.restoreSnapshot(cached);
        const timestamp = new Date(this.now()).toISOString();
        this.dashboardStatusValue = {
          jobId: randomUUID(),
          accountKey: this.account.id,
          scopeKey,
          datasetVersion: cached.datasetVersion,
          stage: "ready",
          processed: cached.scan.scannedMessages,
          total: cached.scan.scannedMessages,
          percent: 100,
          coverage: cached.scan.complete ? "complete" : "partial",
          ready: true,
          source: "cache",
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        return this.dashboardStatus();
      }
    }
    const leaseExpiresAt = new Date(this.now() + 300000).toISOString();
    if (
      !this.store.acquireSyncLease(
        this.account.id,
        this.syncOwner,
        leaseExpiresAt,
        new Date(this.now()).toISOString(),
      )
    ) {
      const state = this.store.syncState(this.account.id);
      const cached = this.store.dashboardSnapshot(this.account.id, scopeKey);
      if (cached) this.restoreSnapshot(cached);
      const timestamp = new Date(this.now()).toISOString();
      this.dashboardStatusValue = {
        jobId: randomUUID(),
        accountKey: this.account.id,
        scopeKey,
        stage:
          state?.status === "cooling_down"
            ? "cooling_down"
            : state?.mode === "incremental"
              ? "incremental_sync"
              : "syncing",
        processed: state?.processedCount ?? 0,
        total: state?.estimatedTotal ?? null,
        percent: null,
        coverage: cached?.scan.complete ? "complete" : cached ? "partial" : "unknown",
        ready: Boolean(cached),
        source: cached ? "cache" : "none",
        startedAt: timestamp,
        updatedAt: state?.updatedAt ?? timestamp,
        syncMode: state?.mode,
        estimatedTotal: state?.estimatedTotal,
        retryAt: state?.retryAt,
      };
      return this.dashboardStatus();
    }
    this.syncLeaseHeld = true;
    const timestamp = new Date(this.now()).toISOString();
    const hasUsableSnapshot = this.dashboardSnapshotValue?.scopeKey === scopeKey;
    this.dashboardStatusValue = {
      jobId: randomUUID(),
      accountKey: this.account.id,
      scopeKey,
      stage: hasUsableSnapshot ? "refreshing" : "connecting",
      processed: 0,
      total: null,
      percent: hasUsableSnapshot ? null : 0,
      coverage: hasUsableSnapshot
        ? this.dashboardSnapshotValue?.scan.complete
          ? "complete"
          : "partial"
        : "unknown",
      ready: Boolean(hasUsableSnapshot),
      source: hasUsableSnapshot ? this.dashboardStatusValue.source : "none",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.dashboardJob = this.prepareDashboard(maxMessages, scopeKey)
      .catch((error) => {
        const safe = safeError(error);
        if (this.activeSyncState) {
          this.activeSyncState = {
            ...this.activeSyncState,
            status: "failed",
            lastError: safe.code,
            updatedAt: new Date(this.now()).toISOString(),
          };
          this.store.saveSyncPage(this.activeSyncState, [], []);
        }
        this.updateDashboardStatus({
          stage: "error",
          percent: null,
          ready: Boolean(this.dashboardSnapshotValue),
          error: {
            ...safe,
            retryable: ["PROVIDER_ERROR", "RATE_LIMITED"].includes(safe.code),
          },
        });
        throw error;
      })
      .finally(() => {
        this.dashboardJob = undefined;
        this.activeSyncState = undefined;
        if (this.syncLeaseHeld) {
          this.store.releaseSyncLease(this.account.id, this.syncOwner);
          this.syncLeaseHeld = false;
        }
      });
    void this.dashboardJob.catch(() => undefined);
    return this.dashboardStatus();
  }
  async initializeDashboard(maxMessages = 1000, force = false): Promise<DashboardSnapshot> {
    this.startDashboardInitialization(maxMessages, force);
    if (this.dashboardJob) await this.dashboardJob;
    return this.dashboardSnapshot();
  }
  async scan(maxMessages: number): Promise<MailboxScanResult> {
    return (await this.initializeDashboard(maxMessages, true)).scan;
  }
  list(input: {
    classification?: Classification;
    minimumMessages: number;
    includeIgnored: boolean;
    sortBy: "MESSAGE_COUNT" | "LATEST";
    limit: number;
    offset: number;
    candidatesOnly: boolean;
    activeWithinDays?: 7 | 30 | 90;
  }) {
    if (!this.cache || this.cache.expires < this.now()) throw new AppError("SCAN_REQUIRED");
    let groups = this.groups(this.cache.messages).filter(
      (g) =>
        (input.includeIgnored || g.detectionEnabled) &&
        (!input.classification || (g.classificationBreakdown[input.classification] ?? 0) > 0) &&
        (!input.activeWithinDays ||
          Date.parse(g.latestMessageAt) >= this.now() - input.activeWithinDays * 86400000) &&
        g.messageCount >= input.minimumMessages &&
        (!input.candidatesOnly || g.candidate),
    );
    groups = groups.sort(
      (a, b) =>
        (input.sortBy === "LATEST"
          ? b.latestMessageAt.localeCompare(a.latestMessageAt)
          : b.messageCount - a.messageCount) || a.sender.email.localeCompare(b.sender.email),
    );
    return {
      items: groups.slice(input.offset, input.offset + input.limit),
      total: groups.length,
      scan: this.cache.summary,
    };
  }
  async messages(senderInput: string, limit: number, cursor?: string) {
    const sender = normalizeAddress(senderInput);
    let providerCursor: string | undefined;
    if (cursor) {
      const c = this.cursors.get(cursor);
      if (!c || c.sender !== sender || c.expires < this.now())
        throw new AppError("VALIDATION_ERROR");
      providerCursor = c.provider;
    }
    const page = await this.provider.scanMessages({
      sender,
      limit,
      ...(providerCursor ? { cursor: providerCursor } : {}),
    });
    for (const m of page.items) this.assertAccount(m);
    let next: string | undefined;
    if (page.cursor) {
      for (const [id, c] of this.cursors) if (c.expires < this.now()) this.cursors.delete(id);
      if (this.cursors.size >= 500) this.cursors.delete(this.cursors.keys().next().value ?? "");
      next = randomUUID();
      this.cursors.set(next, { sender, provider: page.cursor, expires: this.now() + 300000 });
    }
    return {
      items: page.items
        .filter((m) => !m.trashed && m.sender.email === sender)
        .map((m) => ({
          id: m.id,
          subject: m.subject,
          date: m.date,
          unread: m.unread,
          classification: classifyMessage(m),
        })),
      ...(next ? { cursor: next } : {}),
    };
  }
  noiseReport(windowDays: 7 | 30 | 90, limit: number): MailboxNoiseReport {
    if (!this.cache || this.cache.expires < this.now()) throw new AppError("SCAN_REQUIRED");
    const sampledAt = this.cache.summary.generatedAt;
    const cutoff = this.now() - windowDays * 86400000;
    const recentCutoff = (days: number) => this.now() - days * 86400000;
    const inWindow = this.cache.messages.filter((message) => Date.parse(message.date) >= cutoff);
    const senders = this.groups(inWindow)
      .map((group) => {
        const senderMessages =
          this.cache?.messages.filter((message) => message.sender.email === group.sender.email) ??
          [];
        const spanDays = Math.max(
          1,
          (Date.parse(group.latestMessageAt) - Date.parse(group.oldestMessageAt)) / 86400000 + 1,
        );
        return {
          ...group,
          messagesLast7Days: senderMessages.filter(
            (message) => Date.parse(message.date) >= recentCutoff(7),
          ).length,
          messagesLast30Days: senderMessages.filter(
            (message) => Date.parse(message.date) >= recentCutoff(30),
          ).length,
          messagesLast90Days: senderMessages.filter(
            (message) => Date.parse(message.date) >= recentCutoff(90),
          ).length,
          observableMessagesPer30Days: Number(((group.messageCount / spanDays) * 30).toFixed(1)),
        };
      })
      .sort(
        (a, b) => b.messageCount - a.messageCount || a.sender.email.localeCompare(b.sender.email),
      )
      .slice(0, limit);
    return {
      accountId: this.account.id,
      windowDays,
      sampledAt,
      totalScanned: this.cache.messages.length,
      totalInWindow: inWindow.length,
      complete: this.cache.summary.complete,
      coverage: this.cache.summary.complete
        ? "Ventana completa del buzón según el proveedor."
        : `Muestra parcial: se analizaron ${this.cache.summary.scannedMessages} mensajes de un máximo solicitado de ${this.cache.summary.requestedLimit}; no representa el total de la cuenta.`,
      senders,
    };
  }
  setDetection(senderInput: string, detectionEnabled: boolean) {
    const p = {
      sender: normalizeAddress(senderInput),
      accountId: this.account.id,
      detectionEnabled,
      updatedAt: new Date(this.now()).toISOString(),
      source: "USER" as const,
    };
    this.store.setPolicy(p);
    if (this.cache && this.dashboardSnapshotValue) {
      const snapshot = this.buildSnapshot(
        this.cache.messages,
        this.cache.summary,
        this.dashboardSnapshotValue.scopeKey,
      );
      this.dashboardSnapshotValue = snapshot;
      this.store.saveDashboardSnapshot(snapshot);
      this.updateDashboardStatus({ datasetVersion: snapshot.datasetVersion });
    }
    return p;
  }
  invalidate() {
    this.cache = undefined;
    this.dashboardSnapshotValue = undefined;
  }
  group(messages: MailMessage[]): SenderGroup | undefined {
    return this.groups(messages)[0];
  }
}
