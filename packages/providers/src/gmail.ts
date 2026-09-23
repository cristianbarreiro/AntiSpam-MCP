import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type {
  MailAccount,
  MailMessage,
  MailProvider,
  MailSyncPage,
  MailSyncPageInput,
  Page,
  PageInput,
  ProviderSyncEvent,
  Signal,
} from "../../core/src/domain.js";
import { AppError } from "../../core/src/errors.js";
import { normalizeAddress, parseSender } from "../../core/src/sender.js";
import { GMAIL_QUOTA_COST, GmailQuotaScheduler } from "./gmail-quota.js";
export const gmailScope = "https://www.googleapis.com/auth/gmail.modify";
const dto = z.object({
  id: z.string().min(1),
  internalDate: z.string(),
  labelIds: z.array(z.string()).default([]),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) })
    .optional(),
});
export function mapGmailMessage(raw: unknown, accountId: string): MailMessage {
  const r = dto.safeParse(raw);
  if (!r.success) throw new AppError("PROVIDER_ERROR");
  const m = r.data;
  const headers = new Map((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  const signals: Signal[] = [];
  const labels = m.labelIds;
  if (labels.includes("SPAM")) signals.push("SPAM");
  if (labels.includes("IMPORTANT")) signals.push("IMPORTANT");
  if (labels.includes("STARRED")) signals.push("STARRED");
  if (labels.includes("CATEGORY_PROMOTIONS")) signals.push("PROMOTION");
  if (headers.has("list-id")) signals.push("LIST");
  if (headers.has("list-unsubscribe")) signals.push("UNSUBSCRIBE");
  if (headers.has("auto-submitted") && headers.get("auto-submitted")?.toLowerCase() !== "no")
    signals.push("AUTOMATED");
  const ms = Number(m.internalDate);
  if (!Number.isFinite(ms) || ms < 0 || ms > 8640000000000000) throw new AppError("PROVIDER_ERROR");
  try {
    return {
      id: m.id,
      accountId,
      sender: parseSender(headers.get("from") ?? ""),
      subject: (headers.get("subject") ?? "(no subject)").slice(0, 2000),
      date: new Date(ms).toISOString(),
      unread: labels.includes("UNREAD"),
      trashed: labels.includes("TRASH"),
      signals,
    };
  } catch {
    throw new AppError("PROVIDER_ERROR");
  }
}
export interface GmailTransport {
  request(path: string, method?: "GET" | "POST"): Promise<unknown>;
}
function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
export function mapGmailForbidden(payload: unknown): AppError {
  const parsed = z
    .object({
      error: z.object({
        errors: z.array(z.object({ reason: z.string() })).optional(),
      }),
    })
    .safeParse(payload);
  const reasons = parsed.success
    ? (parsed.data.error.errors?.map((error) => error.reason) ?? [])
    : [];
  if (reasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)))
    return new AppError("RATE_LIMITED");
  if (reasons.includes("insufficientPermissions"))
    return new AppError(
      "PERMISSION_DENIED",
      "Gmail authorization lacks the required permission. Run pnpm auth:gmail again and replace the refresh-token file.",
    );
  if (reasons.includes("accessNotConfigured"))
    return new AppError(
      "PERMISSION_DENIED",
      "The Gmail API is not enabled for the Google Cloud project used by GOOGLE_CLIENT_ID.",
    );
  return new AppError("PERMISSION_DENIED");
}
export function gmailTransport(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): GmailTransport {
  const auth = new OAuth2Client({
    clientId,
    clientSecret,
    transporterOptions: { timeout: 15000, retry: false },
  });
  auth.setCredentials({ refresh_token: refreshToken });
  return {
    async request(path, method = "GET") {
      let token: string | null | undefined;
      try {
        token = (await auth.getAccessToken()).token;
      } catch {
        throw new AppError("AUTHENTICATION_ERROR");
      }
      if (!token) throw new AppError("AUTHENTICATION_ERROR");
      let response: Response;
      try {
        response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        throw new AppError("PROVIDER_ERROR");
      }
      if (!response.ok) {
        if (response.status === 401) throw new AppError("AUTHENTICATION_ERROR");
        const retryAfter = retryAfterMilliseconds(response);
        if (response.status === 429) throw new AppError("RATE_LIMITED", undefined, retryAfter);
        if (response.status === 403) {
          const payload: unknown = await response.json().catch(() => null);
          const mapped = mapGmailForbidden(payload);
          throw mapped.code === "RATE_LIMITED"
            ? new AppError("RATE_LIMITED", mapped.message, retryAfter)
            : mapped;
        }
        if (response.status === 400) throw new AppError("VALIDATION_ERROR");
        if (response.status === 404) throw new AppError("NOT_FOUND");
        if ([500, 502, 503, 504].includes(response.status))
          throw new AppError("PROVIDER_ERROR", undefined, retryAfter);
        throw new AppError("PROVIDER_ERROR");
      }
      try {
        return await response.json();
      } catch {
        throw new AppError("PROVIDER_ERROR");
      }
    },
  };
}
export interface GmailProviderOptions {
  quotaBudgetPerMinute?: number;
  maximumBurst?: number;
  concurrency?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  logger?: (event: string, details: Record<string, unknown>) => void;
}
export class GmailProvider implements MailProvider {
  private account: MailAccount | undefined;
  private readonly scheduler: GmailQuotaScheduler;
  private readonly concurrency: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger?: GmailProviderOptions["logger"];
  private observer?: (event: ProviderSyncEvent) => void;
  private cursors = new Map<
    string,
    { token: string; sender: string | undefined; expiry: number }
  >();
  constructor(
    private readonly api: GmailTransport,
    options: GmailProviderOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
    this.maxBackoffMs = Math.max(1000, options.maxBackoffMs ?? 64000);
    this.maxRetries = Math.max(0, Math.min(10, options.maxRetries ?? 8));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
    this.scheduler = new GmailQuotaScheduler({
      budgetPerMinute: options.quotaBudgetPerMinute,
      maximumBurst: options.maximumBurst,
      concurrency: this.concurrency,
      delay: options.delay,
      now: this.now,
      observer: (event) => this.emit(event),
    });
  }
  setSyncObserver(observer: (event: ProviderSyncEvent) => void) {
    this.observer = observer;
    this.scheduler.setObserver((event) => this.emit(event));
  }
  recordSyncEvent(event: string, details: Record<string, unknown>) {
    this.logger?.(`gmail_${event}`, { ...details, ...this.scheduler.metrics() });
  }
  private emit(event: ProviderSyncEvent) {
    this.observer?.(event);
    const logEvent =
      event.type === "quota_wait"
        ? "gmail_quota_wait"
        : event.type === "rate_limited"
          ? "gmail_rate_limited"
          : event.type === "retrying"
            ? "gmail_retry_scheduled"
            : "gmail_request_succeeded";
    this.logger?.(logEvent, {
      ...(event.retryAttempt !== undefined ? { retryAttempt: event.retryAttempt } : {}),
      ...(event.retryDelayMs !== undefined ? { retryDelayMs: event.retryDelayMs } : {}),
      ...(event.retryAt ? { retryAt: event.retryAt } : {}),
      ...(event.metrics ?? {}),
    });
  }
  private async read(path: string, cost: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.scheduler.schedule(cost, () => this.api.request(path));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (!["RATE_LIMITED", "PROVIDER_ERROR"].includes(error.code)) throw error;
        if (attempt >= this.maxRetries) throw error;
        const exponential = Math.min(this.maxBackoffMs, 1000 * 2 ** attempt);
        const jitter = Math.floor(this.random() * 1001);
        const wait = Math.max(
          error.retryAfterMs ?? 0,
          Math.min(this.maxBackoffMs, exponential + jitter),
        );
        this.scheduler.coolDown(wait);
        const retryAt = new Date(this.now() + wait).toISOString();
        if (error.code === "RATE_LIMITED")
          this.emit({
            type: "rate_limited",
            retryAt,
            retryAttempt: attempt + 1,
            retryDelayMs: wait,
            metrics: this.scheduler.metrics(),
          });
        this.emit({
          type: "retrying",
          retryAt,
          retryAttempt: attempt + 1,
          retryDelayMs: wait,
          metrics: this.scheduler.metrics(),
        });
      }
    }
  }
  private async profile() {
    const parsed = z
      .object({ emailAddress: z.string(), historyId: z.string().optional() })
      .safeParse(await this.read("profile", GMAIL_QUOTA_COST.profile));
    if (!parsed.success) throw new AppError("PROVIDER_ERROR");
    return parsed.data;
  }
  async getAccountInfo(): Promise<MailAccount> {
    if (!this.account) {
      const profile = await this.profile();
      const email = normalizeAddress(profile.emailAddress);
      this.account = { id: `gmail:${email}`, provider: "gmail", email };
    }
    return this.account;
  }
  async currentHistoryId(): Promise<string> {
    const historyId = (await this.profile()).historyId;
    if (!historyId) throw new AppError("PROVIDER_ERROR");
    return historyId;
  }
  async getMessageMetadata(id: string) {
    return (await this.getMessageMetadataRecord(id)).message;
  }
  private async getMessageMetadataRecord(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new AppError("VALIDATION_ERROR");
    const params = new URLSearchParams({
      format: "metadata",
      fields: "id,internalDate,labelIds,payload/headers",
    });
    for (const h of [
      "From",
      "Subject",
      "Date",
      "List-Unsubscribe",
      "List-ID",
      "Precedence",
      "Auto-Submitted",
    ])
      params.append("metadataHeaders", h);
    const raw = await this.read(
      `messages/${encodeURIComponent(id)}?${params}`,
      GMAIL_QUOTA_COST.messagesGet,
    );
    const parsed = dto.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_ERROR");
    return {
      message: mapGmailMessage(raw, (await this.getAccountInfo()).id),
      inAnalysisScope: !parsed.data.labelIds.some((label) =>
        ["TRASH", "SENT", "DRAFT"].includes(label),
      ),
    };
  }
  private async metadataFor(ids: string[]) {
    const items: MailMessage[] = [];
    const deletedIds: string[] = [];
    const excludedIds: string[] = [];
    for (let offset = 0; offset < ids.length; offset += this.concurrency) {
      const batch = await Promise.all(
        ids.slice(offset, offset + this.concurrency).map(async (id) => {
          try {
            const record = await this.getMessageMetadataRecord(id);
            return record.inAnalysisScope
              ? { message: record.message }
              : { excludedId: record.message.id };
          } catch (error) {
            if (error instanceof AppError && error.code === "NOT_FOUND") return { deletedId: id };
            throw error;
          }
        }),
      );
      for (const result of batch) {
        if (result.message) items.push(result.message);
        if (result.deletedId) deletedIds.push(result.deletedId);
        if (result.excludedId) excludedIds.push(result.excludedId);
      }
    }
    return { items, deletedIds, excludedIds };
  }
  async scanMessages(input: PageInput): Promise<Page<MailMessage>> {
    if (input.limit < 1 || input.limit > 100) throw new AppError("VALIDATION_ERROR");
    const sender = input.sender ? normalizeAddress(input.sender) : undefined;
    const query = `-in:trash -in:sent -in:drafts${sender ? ` from:"${sender}"` : ""}`;
    const params = new URLSearchParams({
      q: query,
      maxResults: String(input.limit),
      includeSpamTrash: "true",
      fields: "messages/id,nextPageToken,resultSizeEstimate",
    });
    if (input.cursor) {
      const c = this.cursors.get(input.cursor);
      if (!c || c.sender !== sender || c.expiry < Date.now())
        throw new AppError("VALIDATION_ERROR");
      params.set("pageToken", c.token);
    }
    const r = z
      .object({
        messages: z.array(z.object({ id: z.string() })).default([]),
        nextPageToken: z.string().optional(),
        resultSizeEstimate: z.number().int().nonnegative().optional(),
      })
      .safeParse(await this.read(`messages?${params}`, GMAIL_QUOTA_COST.messagesList));
    if (!r.success) throw new AppError("PROVIDER_ERROR");
    const items: MailMessage[] = [];
    const concurrency = this.concurrency;
    for (let offset = 0; offset < r.data.messages.length; offset += concurrency) {
      const batch = await Promise.all(
        r.data.messages.slice(offset, offset + concurrency).map(async (ref) => {
          try {
            return await this.getMessageMetadata(ref.id);
          } catch (error) {
            if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
            throw error;
          }
        }),
      );
      for (const message of batch)
        if (message && !message.trashed && (!sender || message.sender.email === sender))
          items.push(message);
    }
    let cursor: string | undefined;
    if (r.data.nextPageToken) {
      for (const [id, c] of this.cursors) if (c.expiry < Date.now()) this.cursors.delete(id);
      if (this.cursors.size >= 500) this.cursors.delete(this.cursors.keys().next().value ?? "");
      cursor = randomUUID();
      this.cursors.set(cursor, {
        token: r.data.nextPageToken,
        sender,
        expiry: Date.now() + 300000,
      });
    }
    return {
      items,
      ...(cursor ? { cursor } : {}),
      ...(r.data.resultSizeEstimate !== undefined
        ? { resultSizeEstimate: r.data.resultSizeEstimate }
        : {}),
    };
  }
  async syncPage(input: MailSyncPageInput): Promise<MailSyncPage> {
    if (input.limit < 1 || input.limit > 100) throw new AppError("VALIDATION_ERROR");
    if (input.mode === "full") {
      const params = new URLSearchParams({
        q: "-in:trash -in:sent -in:drafts",
        maxResults: String(input.limit),
        includeSpamTrash: "true",
        fields: "messages/id,nextPageToken,resultSizeEstimate",
      });
      if (input.pageToken) params.set("pageToken", input.pageToken);
      const parsed = z
        .object({
          messages: z.array(z.object({ id: z.string() })).default([]),
          nextPageToken: z.string().optional(),
          resultSizeEstimate: z.number().int().nonnegative().optional(),
        })
        .safeParse(await this.read(`messages?${params}`, GMAIL_QUOTA_COST.messagesList));
      if (!parsed.success) throw new AppError("PROVIDER_ERROR");
      const metadata = await this.metadataFor(parsed.data.messages.map(({ id }) => id));
      this.logger?.("gmail_page_fetched", {
        syncType: "full",
        processed: metadata.items.length,
        estimatedTotal: parsed.data.resultSizeEstimate,
        ...this.scheduler.metrics(),
      });
      return {
        upserts: metadata.items.filter((message) => !message.trashed),
        deletedIds: [...metadata.deletedIds, ...metadata.excludedIds],
        processed: parsed.data.messages.length,
        ...(parsed.data.nextPageToken ? { nextPageToken: parsed.data.nextPageToken } : {}),
        ...(parsed.data.resultSizeEstimate !== undefined
          ? { estimatedTotal: parsed.data.resultSizeEstimate }
          : {}),
      };
    }
    if (!input.historyId) throw new AppError("VALIDATION_ERROR");
    const params = new URLSearchParams({
      startHistoryId: input.historyId,
      maxResults: "100",
      fields:
        "history(id,messagesAdded/message/id,messagesDeleted/message/id,labelsAdded/message/id,labelsRemoved/message/id),nextPageToken,historyId",
    });
    if (input.pageToken) params.set("pageToken", input.pageToken);
    const parsed = z
      .object({
        history: z
          .array(
            z.object({
              messagesAdded: z
                .array(z.object({ message: z.object({ id: z.string() }) }))
                .optional(),
              messagesDeleted: z
                .array(z.object({ message: z.object({ id: z.string() }) }))
                .optional(),
              labelsAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
              labelsRemoved: z
                .array(z.object({ message: z.object({ id: z.string() }) }))
                .optional(),
            }),
          )
          .default([]),
        nextPageToken: z.string().optional(),
        historyId: z.string(),
      })
      .safeParse(await this.read(`history?${params}`, GMAIL_QUOTA_COST.historyList));
    if (!parsed.success) throw new AppError("PROVIDER_ERROR");
    const changed = new Set<string>();
    const deleted = new Set<string>();
    for (const record of parsed.data.history) {
      for (const item of record.messagesAdded ?? []) changed.add(item.message.id);
      for (const item of record.labelsAdded ?? []) changed.add(item.message.id);
      for (const item of record.labelsRemoved ?? []) changed.add(item.message.id);
      for (const item of record.messagesDeleted ?? []) deleted.add(item.message.id);
    }
    for (const id of deleted) changed.delete(id);
    const metadata = await this.metadataFor([...changed]);
    for (const id of metadata.deletedIds) deleted.add(id);
    for (const id of metadata.excludedIds) deleted.add(id);
    this.logger?.("gmail_page_fetched", {
      syncType: "incremental",
      processed: metadata.items.length,
      deleted: deleted.size,
      ...this.scheduler.metrics(),
    });
    return {
      upserts: metadata.items.filter((message) => !message.trashed),
      deletedIds: [
        ...deleted,
        ...metadata.items.filter((message) => message.trashed).map((m) => m.id),
      ],
      processed: changed.size + deleted.size,
      ...(parsed.data.nextPageToken ? { nextPageToken: parsed.data.nextPageToken } : {}),
      historyId: parsed.data.historyId,
    };
  }
  async moveToTrash(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new AppError("VALIDATION_ERROR");
    await this.scheduler.schedule(GMAIL_QUOTA_COST.messagesTrash, () =>
      this.api.request(`messages/${encodeURIComponent(id)}/trash`, "POST"),
    );
  }
}
