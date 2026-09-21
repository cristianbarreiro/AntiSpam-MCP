import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type {
  MailAccount,
  MailMessage,
  MailProvider,
  Page,
  PageInput,
  Signal,
} from "../../core/src/domain.js";
import { AppError } from "../../core/src/errors.js";
import { normalizeAddress, parseSender } from "../../core/src/sender.js";
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
        if (response.status === 429) throw new AppError("RATE_LIMITED");
        if (response.status === 403) {
          const payload: unknown = await response.json().catch(() => null);
          throw mapGmailForbidden(payload);
        }
        if (response.status === 404) throw new AppError("NOT_FOUND");
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
export class GmailProvider implements MailProvider {
  private account: MailAccount | undefined;
  private cursors = new Map<
    string,
    { token: string; sender: string | undefined; expiry: number }
  >();
  constructor(
    private readonly api: GmailTransport,
    private readonly delay = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    private readonly metadataConcurrency = 8,
  ) {}
  private async read(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.api.request(path);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !["RATE_LIMITED", "PROVIDER_ERROR"].includes(error.code) ||
          attempt === 2
        )
          throw error;
        await this.delay(250 * 2 ** attempt);
      }
    }
    throw new AppError("PROVIDER_ERROR");
  }
  async getAccountInfo(): Promise<MailAccount> {
    if (!this.account) {
      const r = z.object({ emailAddress: z.string() }).safeParse(await this.read("profile"));
      if (!r.success) throw new AppError("PROVIDER_ERROR");
      const email = normalizeAddress(r.data.emailAddress);
      this.account = { id: `gmail:${email}`, provider: "gmail", email };
    }
    return this.account;
  }
  async getMessageMetadata(id: string) {
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
    return mapGmailMessage(
      await this.read(`messages/${encodeURIComponent(id)}?${params}`),
      (await this.getAccountInfo()).id,
    );
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
      .safeParse(await this.read(`messages?${params}`));
    if (!r.success) throw new AppError("PROVIDER_ERROR");
    const items: MailMessage[] = [];
    const concurrency = Math.max(1, Math.min(16, this.metadataConcurrency));
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
  async moveToTrash(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new AppError("VALIDATION_ERROR");
    await this.api.request(`messages/${encodeURIComponent(id)}/trash`, "POST");
  }
}
