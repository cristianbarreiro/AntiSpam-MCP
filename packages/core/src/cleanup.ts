import { createHash, randomBytes, randomUUID } from "node:crypto";
import { classifyMessage } from "./classification.js";
import type {
  Classification,
  CleanupConfirmation,
  CleanupPreview,
  CleanupResult,
  CleanupSelection,
  FrozenCleanupItem,
  MailMessage,
  Outcome,
} from "./domain.js";
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
  private buildPreview(
    messages: MailMessage[],
    warnings: string[],
    allowIgnoredSenders = new Set<string>(),
  ): CleanupPreview {
    if (messages.length === 0) throw new AppError("NOT_FOUND");
    if (messages.length > 1000) throw new AppError("MAILBOX_CHANGED");
    const sorted = [...messages].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    );
    const frozen = sorted.map((message): FrozenCleanupItem => {
      const classification = classifyMessage(message);
      return {
        id: message.id,
        sender: message.sender.email,
        classification: classification.classification,
        protections: classification.protections,
        ...(allowIgnoredSenders.has(message.sender.email) ? { allowIgnored: true } : {}),
      };
    });
    const senderGroups = new Map<string, MailMessage[]>();
    for (const message of sorted) {
      const group = senderGroups.get(message.sender.email) ?? [];
      group.push(message);
      senderGroups.set(message.sender.email, group);
    }
    const senders = [...senderGroups].map(([sender, items]) => {
      const classificationBreakdown: Partial<Record<Classification, number>> = {};
      for (const item of items.map(classifyMessage))
        classificationBreakdown[item.classification] =
          (classificationBreakdown[item.classification] ?? 0) + 1;
      return {
        sender,
        messageCount: items.length,
        unreadCount: items.filter((message) => message.unread).length,
        classificationBreakdown,
      };
    });
    const requiresProtectedConfirmation = frozen.some((item) => item.protections.length > 0);
    const p: CleanupPreview = {
      id: randomUUID(),
      accountId: this.account,
      ...(senders.length === 1 ? { sender: senders[0]?.sender } : {}),
      messageIds: frozen.map((item) => item.id).sort(),
      messageCount: frozen.length,
      unreadCount: sorted.filter((message) => message.unread).length,
      oldestMessageAt: sorted[0]?.date ?? "",
      latestMessageAt: sorted.at(-1)?.date ?? "",
      action: "MOVE_TO_TRASH",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 600000).toISOString(),
      status: "PENDING",
      items: frozen,
      senders,
      warnings: [
        ...warnings,
        ...(requiresProtectedConfirmation
          ? ["La selección incluye mensajes protegidos y requiere una confirmación separada."]
          : []),
      ],
      requiresProtectedConfirmation,
    };
    this.store.savePreview(p);
    return p;
  }
  async preview(senderInput: string): Promise<CleanupPreview> {
    const sender = normalizeAddress(senderInput);
    const { messages, complete } = await this.mailbox.collect(1000, sender);
    if (!complete) throw new AppError("MAILBOX_CHANGED");
    return this.buildPreview(
      messages,
      ["Vista compatible por remitente: conserva el alcance completo de la operación original."],
      new Set([sender]),
    );
  }
  async planPreview(selections: CleanupSelection[]): Promise<CleanupPreview> {
    if (selections.length < 1 || selections.length > 20) throw new AppError("VALIDATION_ERROR");
    const selected = new Map<string, MailMessage>();
    const warnings: string[] = [];
    const allowIgnoredSenders = new Set<string>();
    const seenSenders = new Set<string>();
    for (const selection of selections) {
      const sender = normalizeAddress(selection.sender);
      if (seenSenders.has(sender)) throw new AppError("VALIDATION_ERROR");
      seenSenders.add(sender);
      const criteria = selection.criteria ?? {};
      if (criteria.after && criteria.before && criteria.after >= criteria.before)
        throw new AppError("VALIDATION_ERROR");
      const policyIgnored = this.store.policy(this.account, sender)?.detectionEnabled === false;
      if (policyIgnored && !criteria.includeIgnored) {
        warnings.push(`${sender}: excluido por la política IGNORE de la cuenta.`);
        continue;
      }
      if (policyIgnored && criteria.includeIgnored) allowIgnoredSenders.add(sender);
      let candidates: MailMessage[];
      if (selection.messageIds?.length) {
        if (selection.messageIds.length > 1000) throw new AppError("VALIDATION_ERROR");
        candidates = [];
        for (const id of [...new Set(selection.messageIds)]) {
          const message = await this.mailbox.provider.getMessageMetadata(id);
          this.mailbox.assertAccount(message);
          if (message.sender.email !== sender) throw new AppError("MAILBOX_CHANGED");
          if (!message.trashed) candidates.push(message);
          else warnings.push(`${sender}: un mensaje ya estaba en Papelera y quedó fuera del plan.`);
        }
      } else {
        const collected = await this.mailbox.collect(1001, sender);
        if (!collected.complete || collected.messages.length > 1000)
          throw new AppError("MAILBOX_CHANGED");
        candidates = collected.messages;
      }
      let protectedExcluded = 0;
      for (const message of candidates) {
        const classification = classifyMessage(message);
        if (criteria.after && message.date < criteria.after) continue;
        if (criteria.before && message.date >= criteria.before) continue;
        if (criteria.readState === "READ" && message.unread) continue;
        if (criteria.readState === "UNREAD" && !message.unread) continue;
        if (
          criteria.classifications?.length &&
          !criteria.classifications.includes(classification.classification)
        )
          continue;
        const allowed = new Set(criteria.includeProtected ?? []);
        if (classification.protections.some((protection) => !allowed.has(protection))) {
          protectedExcluded++;
          continue;
        }
        selected.set(message.id, message);
        if (selected.size > 1000) throw new AppError("MAILBOX_CHANGED");
      }
      if (protectedExcluded)
        warnings.push(`${sender}: ${protectedExcluded} mensajes protegidos quedaron excluidos.`);
    }
    return this.buildPreview([...selected.values()], warnings, allowIgnoredSenders);
  }
  // Only the authenticated local human-control adapter receives these capabilities.
  confirmProtectedFromHuman(id: string): CleanupPreview {
    return this.store.confirmProtected(this.account, id, new Date(this.now()).toISOString());
  }
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
  private frozenItems(p: CleanupPreview): FrozenCleanupItem[] {
    return (
      p.items ??
      p.messageIds.map((id) => ({
        id,
        sender: p.sender ?? "",
        classification: "UNKNOWN" as const,
        protections: [],
        allowIgnored: true,
      }))
    );
  }
  result(id: string): CleanupResult {
    const p = this.store.preview(this.account, id);
    const outcomes = this.store.outcomes(this.account, id);
    const count = (values: Outcome[], outcome: Outcome) =>
      values.filter((v) => v === outcome).length;
    const values = Object.values(outcomes);
    const bySender = new Map<string, FrozenCleanupItem[]>();
    for (const item of this.frozenItems(p)) {
      const group = bySender.get(item.sender) ?? [];
      group.push(item);
      bySender.set(item.sender, group);
    }
    return {
      previewId: id,
      status: p.status,
      moved: count(values, "MOVED"),
      failed: count(values, "FAILED"),
      uncertain: count(values, "UNCERTAIN"),
      alreadyTrashed: count(values, "ALREADY_TRASHED"),
      remaining: p.messageCount - values.length,
      bySender: [...bySender].map(([sender, items]) => {
        const itemOutcomes = items
          .map((item) => outcomes[item.id])
          .filter((outcome): outcome is Outcome => outcome !== undefined);
        return {
          sender,
          moved: count(itemOutcomes, "MOVED"),
          failed: count(itemOutcomes, "FAILED"),
          uncertain: count(itemOutcomes, "UNCERTAIN"),
          alreadyTrashed: count(itemOutcomes, "ALREADY_TRASHED"),
          remaining: items.length - itemOutcomes.length,
        };
      }),
    };
  }
  async execute(id: string, token: string): Promise<CleanupResult> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("CONFIRMATION_REQUIRED");
    const p = this.store.claim(this.account, id, hash(token), new Date(this.now()).toISOString());
    const frozen = new Map(this.frozenItems(p).map((item) => [item.id, item]));
    this.active.add(id);
    try {
      for (const messageId of p.messageIds) {
        if (this.store.cancelled(this.account, id)) break;
        this.store.recordOutcome(this.account, id, messageId, "UNCERTAIN");
        let outcome: Outcome = "MOVED";
        try {
          const current = await this.mailbox.provider.getMessageMetadata(messageId);
          this.mailbox.assertAccount(current);
          const approved = frozen.get(messageId);
          if (!approved || current.sender.email !== approved.sender)
            throw new AppError("MAILBOX_CHANGED");
          if (
            this.store.policy(this.account, approved.sender)?.detectionEnabled === false &&
            !approved.allowIgnored
          )
            throw new AppError("MAILBOX_CHANGED");
          const currentProtections = classifyMessage(current).protections;
          if (currentProtections.some((protection) => !approved.protections.includes(protection)))
            throw new AppError("MAILBOX_CHANGED");
          if (current.trashed) outcome = "ALREADY_TRASHED";
          else await this.mailbox.provider.moveToTrash(messageId);
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
