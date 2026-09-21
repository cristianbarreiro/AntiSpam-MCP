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
  dashboardStatus(): DashboardJobStatus {
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
  private async prepareDashboard(maxMessages: number, scopeKey: string) {
    this.updateDashboardStatus({
      stage: this.dashboardSnapshotValue ? "refreshing" : "connecting",
      processed: 0,
      total: null,
      percent: this.dashboardSnapshotValue ? null : 5,
    });
    this.updateDashboardStatus({ stage: "fetching", percent: null });
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
