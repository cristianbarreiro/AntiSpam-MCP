import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MailSyncPage,
  MailSyncPageInput,
  ProviderSyncEvent,
} from "../packages/core/src/domain.js";
import { AppError } from "../packages/core/src/errors.js";
import { MailboxService } from "../packages/core/src/mailbox.js";
import { GMAIL_QUOTA_COST, GmailQuotaScheduler } from "../packages/providers/src/gmail-quota.js";
import { MockProvider, mockAccount, syntheticMessages } from "../packages/providers/src/mock.js";
import { SqliteStore } from "../packages/storage/src/sqlite.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class ScriptedSyncProvider extends MockProvider {
  readonly inputs: MailSyncPageInput[] = [];
  private observer?: (event: ProviderSyncEvent) => void;

  constructor(
    private readonly page: (input: MailSyncPageInput, call: number) => Promise<MailSyncPage>,
    private readonly historyId = "history-10",
  ) {
    super();
  }

  setSyncObserver(observer: (event: ProviderSyncEvent) => void) {
    this.observer = observer;
  }

  emit(event: ProviderSyncEvent) {
    this.observer?.(event);
  }

  async syncPage(input: MailSyncPageInput) {
    this.inputs.push(structuredClone(input));
    return this.page(input, this.inputs.length);
  }

  async currentHistoryId() {
    return this.historyId;
  }
}

describe("quota-aware Gmail synchronization", () => {
  it("paces 1000 metadata reads against quota units instead of request count", async () => {
    let now = 0;
    let requests = 0;
    const scheduler = new GmailQuotaScheduler({
      budgetPerMinute: 2000,
      maximumBurst: 400,
      concurrency: 2,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
    });

    for (let index = 0; index < 1000; index++)
      await scheduler.schedule(GMAIL_QUOTA_COST.messagesGet, async () => {
        requests++;
      });

    expect(requests).toBe(1000);
    expect(now).toBeGreaterThanOrEqual(588000);
    expect(scheduler.metrics()).toMatchObject({
      quotaBudget: 2000,
      currentConcurrency: 2,
      activeRequests: 0,
    });
  });

  it("does not let a request already queued for concurrency bypass a new cooldown", async () => {
    let now = 0;
    let releaseDelay: (() => void) | undefined;
    let secondStarted = false;
    const waits: number[] = [];
    const scheduler = new GmailQuotaScheduler({
      budgetPerMinute: 2000,
      maximumBurst: 400,
      concurrency: 1,
      now: () => now,
      delay: async (milliseconds) => {
        waits.push(milliseconds);
        await new Promise<void>((resolve) => {
          releaseDelay = () => {
            now += milliseconds;
            resolve();
          };
        });
      },
    });
    let second: Promise<void> | undefined;
    await scheduler.schedule(GMAIL_QUOTA_COST.messagesGet, async () => {
      second = scheduler.schedule(GMAIL_QUOTA_COST.messagesGet, async () => {
        secondStarted = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      scheduler.coolDown(5000);
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(waits).toEqual([5000]);
    releaseDelay?.();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("checkpoints pages, resumes after restart, upserts duplicates and then uses historyId", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inboxguardian-sync-test-"));
    directories.push(directory);
    const path = join(directory, "sync.sqlite");
    const [first, second, third] = syntheticMessages();
    if (!first || !second || !third) throw new Error("Missing fixtures");

    const firstStore = new SqliteStore(path);
    firstStore.migrate();
    const interrupted = new ScriptedSyncProvider(async (_input, call) => {
      if (call === 1)
        return {
          upserts: [first, second],
          deletedIds: [],
          processed: 2,
          nextPageToken: "page-2",
          estimatedTotal: 3,
        };
      throw new AppError("PROVIDER_ERROR");
    });
    const firstMailbox = new MailboxService(interrupted, firstStore, mockAccount);
    await expect(firstMailbox.initializeDashboard(1000, true)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(firstStore.syncState(mockAccount.id)).toMatchObject({
      status: "failed",
      nextPageToken: "page-2",
      processedCount: 2,
    });
    expect(firstStore.syncMessages(mockAccount.id, 1000)).toHaveLength(2);
    firstStore.close();

    const secondStore = new SqliteStore(path);
    secondStore.migrate();
    const resumed = new ScriptedSyncProvider(async (input) => {
      expect(input).toMatchObject({ mode: "full", pageToken: "page-2" });
      return {
        upserts: [{ ...second, subject: "updated after resume" }, third],
        deletedIds: [],
        processed: 2,
        estimatedTotal: 3,
      };
    });
    const secondMailbox = new MailboxService(resumed, secondStore, mockAccount);
    const completed = await secondMailbox.initializeDashboard(1000, true);
    expect(completed.messages).toHaveLength(3);
    expect(completed.messages.find(({ id }) => id === second.id)?.subject).toBe(
      "updated after resume",
    );
    expect(secondStore.syncState(mockAccount.id)).toMatchObject({
      status: "completed",
      lastHistoryId: "history-10",
    });

    const incremental = new ScriptedSyncProvider(async (input) => {
      expect(input).toMatchObject({ mode: "incremental", historyId: "history-10" });
      return {
        upserts: [{ ...first, subject: "incremental update" }],
        deletedIds: [third.id],
        processed: 2,
        historyId: "history-11",
      };
    });
    const incrementalMailbox = new MailboxService(incremental, secondStore, mockAccount);
    const refreshed = await incrementalMailbox.initializeDashboard(1000, true);
    expect(refreshed.messages).toHaveLength(2);
    expect(refreshed.messages.find(({ id }) => id === first.id)?.subject).toBe(
      "incremental update",
    );
    expect(secondStore.syncState(mockAccount.id)).toMatchObject({
      mode: "incremental",
      status: "completed",
      lastHistoryId: "history-11",
    });
    secondStore.close();
  });

  it("falls back to a paced full reconciliation when historyId expired", async () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    const [first, second] = syntheticMessages();
    if (!first || !second) throw new Error("Missing fixtures");
    store.saveSyncPage(
      {
        accountId: mockAccount.id,
        mode: "full",
        status: "completed",
        generation: "old-generation",
        processedCount: 2,
        lastHistoryId: "expired-history",
        updatedAt: new Date().toISOString(),
      },
      [first, second],
      [],
    );
    const provider = new ScriptedSyncProvider(async (input, call) => {
      if (call === 1) {
        expect(input.mode).toBe("incremental");
        throw new AppError("NOT_FOUND");
      }
      expect(input.mode).toBe("full");
      return { upserts: [second], deletedIds: [], processed: 1, estimatedTotal: 1 };
    }, "history-20");
    const mailbox = new MailboxService(provider, store, mockAccount);
    const snapshot = await mailbox.initializeDashboard(1000, true);
    expect(provider.inputs.map(({ mode }) => mode)).toEqual(["incremental", "full"]);
    expect(snapshot.messages.map(({ id }) => id)).toEqual([second.id]);
    expect(store.syncState(mockAccount.id)).toMatchObject({ lastHistoryId: "history-20" });
    store.close();
  });

  it("keeps the stable historyId through paginated incremental resume", async () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    const [first, second, third] = syntheticMessages();
    if (!first || !second || !third) throw new Error("Missing fixtures");
    store.saveSyncPage(
      {
        accountId: mockAccount.id,
        mode: "full",
        status: "completed",
        generation: "complete-generation",
        processedCount: 1,
        lastHistoryId: "history-10",
        updatedAt: new Date().toISOString(),
      },
      [first],
      [],
    );
    const interrupted = new ScriptedSyncProvider(async (input, call) => {
      if (call === 1) {
        expect(input).toMatchObject({ mode: "incremental", historyId: "history-10" });
        return {
          upserts: [second],
          deletedIds: [],
          processed: 1,
          nextPageToken: "history-page-2",
          historyId: "history-20",
        };
      }
      throw new AppError("PROVIDER_ERROR");
    });
    const firstMailbox = new MailboxService(interrupted, store, mockAccount);
    await expect(firstMailbox.initializeDashboard(1000, true)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(store.syncState(mockAccount.id)).toMatchObject({
      status: "failed",
      lastHistoryId: "history-10",
      historyStartId: "history-10",
      nextPageToken: "history-page-2",
    });

    const resumed = new ScriptedSyncProvider(async (input) => {
      expect(input).toMatchObject({
        mode: "incremental",
        historyId: "history-10",
        pageToken: "history-page-2",
      });
      return {
        upserts: [third],
        deletedIds: [],
        processed: 1,
        historyId: "history-21",
      };
    });
    const secondMailbox = new MailboxService(resumed, store, mockAccount);
    await secondMailbox.initializeDashboard(1000, true);
    expect(store.syncState(mockAccount.id)).toMatchObject({
      status: "completed",
      lastHistoryId: "history-21",
    });
    expect(store.syncState(mockAccount.id)?.historyStartId).toBeUndefined();
    store.close();
  });

  it("exposes cooldown without failing and prevents a second account worker", async () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const [message] = syntheticMessages();
    if (!message) throw new Error("Missing fixture");
    const firstProvider = new ScriptedSyncProvider(async () => {
      firstProvider.emit({
        type: "rate_limited",
        retryAt: "2026-09-21T13:00:08.000Z",
        retryDelayMs: 8000,
      });
      await gate;
      return { upserts: [message], deletedIds: [], processed: 1, estimatedTotal: 1 };
    });
    const firstMailbox = new MailboxService(firstProvider, store, mockAccount);
    firstMailbox.startDashboardInitialization(1000, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstMailbox.dashboardStatus()).toMatchObject({
      stage: "cooling_down",
      retryAt: "2026-09-21T13:00:08.000Z",
    });

    const secondProvider = new ScriptedSyncProvider(async () => {
      throw new Error("second worker should not start");
    });
    const secondMailbox = new MailboxService(secondProvider, store, mockAccount);
    expect(secondMailbox.startDashboardInitialization(1000, true).stage).toBe("cooling_down");
    expect(secondProvider.inputs).toHaveLength(0);
    release?.();
    await firstMailbox.initializeDashboard(1000);
    store.close();
  });
});
