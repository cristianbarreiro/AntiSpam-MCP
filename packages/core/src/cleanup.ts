import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CleanupConfirmation, CleanupPreview, CleanupResult, Outcome } from "./domain.js";
import { AppError } from "./errors.js";
import type { MailboxService } from "./mailbox.js";
import { normalizeAddress } from "./sender.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class CleanupService {
  private active = new Set<string>();
  constructor(
    private readonly mailbox: MailboxService,
    private readonly now = () => Date.now(),
  ) {}
  private get account() {
    return this.mailbox.account.id;
  }
  private get store() {
    return this.mailbox.store;
  }
  async preview(senderInput: string): Promise<CleanupPreview> {
    const sender = normalizeAddress(senderInput);
    const { messages, complete } = await this.mailbox.collect(1000, sender);
    if (!complete) throw new AppError("MAILBOX_CHANGED");
    const group = this.mailbox.group(messages);
    if (!group) throw new AppError("NOT_FOUND");
    const p: CleanupPreview = {
      id: randomUUID(),
      accountId: this.account,
      sender,
      messageIds: messages.map((m) => m.id).sort(),
      messageCount: messages.length,
      unreadCount: group.unreadCount,
      oldestMessageAt: group.oldestMessageAt,
      latestMessageAt: group.latestMessageAt,
      action: "MOVE_TO_TRASH",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 600000).toISOString(),
      status: "PENDING",
    };
    this.store.savePreview(p);
    return p;
  }
  // Only the authenticated local human-control adapter receives this capability.
  confirmFromHuman(id: string): CleanupConfirmation {
    const p = this.store.preview(this.account, id);
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Math.min(this.now() + 120000, Date.parse(p.expiresAt)),
    ).toISOString();
    this.store.confirm(
      this.account,
      id,
      hash(token),
      expiresAt,
      new Date(this.now()).toISOString(),
    );
    return { token, previewId: id, expiresAt };
  }
  pending() {
    return this.store.pending(this.account);
  }
  cancel(id: string) {
    this.store.cancel(this.account, id);
    return { cancelled: true, previewId: id };
  }
  result(id: string): CleanupResult {
    const p = this.store.preview(this.account, id);
    const values = Object.values(this.store.outcomes(this.account, id));
    return {
      previewId: id,
      status: p.status,
      moved: values.filter((v) => v === "MOVED").length,
      failed: values.filter((v) => v === "FAILED").length,
      uncertain: values.filter((v) => v === "UNCERTAIN").length,
      remaining: p.messageCount - values.length,
    };
  }
  async execute(id: string, token: string): Promise<CleanupResult> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("CONFIRMATION_REQUIRED");
    const p = this.store.claim(this.account, id, hash(token), new Date(this.now()).toISOString());
    this.active.add(id);
    try {
      for (const messageId of p.messageIds) {
        if (this.store.cancelled(this.account, id)) break;
        // Write intent before the provider side effect; a crash leaves it explicitly uncertain.
        this.store.recordOutcome(this.account, id, messageId, "UNCERTAIN");
        let outcome: Outcome = "MOVED";
        try {
          const current = await this.mailbox.provider.getMessageMetadata(messageId);
          this.mailbox.assertAccount(current);
          if (current.sender.email !== p.sender) throw new AppError("MAILBOX_CHANGED");
          if (!current.trashed) await this.mailbox.provider.moveToTrash(messageId);
        } catch (error) {
          outcome =
            error instanceof AppError &&
            [
              "NOT_FOUND",
              "PERMISSION_DENIED",
              "AUTHENTICATION_ERROR",
              "RATE_LIMITED",
              "MAILBOX_CHANGED",
            ].includes(error.code)
              ? "FAILED"
              : "UNCERTAIN";
        }
        this.store.recordOutcome(this.account, id, messageId, outcome);
      }
      const r = this.result(id);
      this.store.finish(
        this.account,
        id,
        r.uncertain
          ? "UNCERTAIN"
          : this.store.cancelled(this.account, id)
            ? "CANCELLED"
            : r.failed
              ? "PARTIAL"
              : "COMPLETED",
      );
      return this.result(id);
    } catch {
      // Never retry side effects on a storage failure. Persisted intent supports read-only reconciliation.
      try {
        this.store.finish(this.account, id, "UNCERTAIN");
      } catch {
        /* Storage may still be unavailable. */
      }
      throw new AppError("INTERNAL_ERROR");
    } finally {
      this.active.delete(id);
      this.mailbox.invalidate();
    }
  }
  async reconcile(id: string): Promise<CleanupResult> {
    if (this.active.has(id)) throw new AppError("VALIDATION_ERROR");
    const p = this.store.preview(this.account, id);
    if (!["EXECUTING", "UNCERTAIN"].includes(p.status)) return this.result(id);
    for (const [messageId, outcome] of Object.entries(this.store.outcomes(this.account, id))) {
      if (outcome !== "UNCERTAIN") continue;
      try {
        const m = await this.mailbox.provider.getMessageMetadata(messageId);
        this.mailbox.assertAccount(m);
        if (m.trashed) this.store.recordOutcome(this.account, id, messageId, "MOVED");
        // A non-trashed message may have been restored by the user: leave it uncertain.
      } catch {
        /* No inference from an unavailable provider. */
      }
    }
    const r = this.result(id);
    this.store.finish(
      this.account,
      id,
      r.uncertain ? "UNCERTAIN" : r.remaining || r.failed ? "PARTIAL" : "COMPLETED",
    );
    return this.result(id);
  }
}
