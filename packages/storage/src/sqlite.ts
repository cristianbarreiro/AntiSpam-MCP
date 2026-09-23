import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  CleanupPreview,
  DashboardSnapshot,
  MailMessage,
  MailSyncState,
  Outcome,
  PreviewStatus,
  SenderPolicy,
} from "../../core/src/domain.js";
import { AppError } from "../../core/src/errors.js";
import type { Store } from "../../core/src/store.js";

const migration1 = `
CREATE TABLE sender_policies(account TEXT NOT NULL, sender TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated TEXT NOT NULL, PRIMARY KEY(account,sender)) STRICT;
CREATE TABLE cleanup_previews(id TEXT PRIMARY KEY, account TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, token_hash TEXT, token_expiry TEXT, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX previews_account ON cleanup_previews(account,status);
CREATE TABLE cleanup_outcomes(preview_id TEXT NOT NULL REFERENCES cleanup_previews(id) ON DELETE CASCADE, message_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(preview_id,message_id)) STRICT;
CREATE TABLE audit_events(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL, account TEXT NOT NULL, preview_id TEXT, count INTEGER, result TEXT) STRICT;
CREATE INDEX audit_account ON audit_events(account,id);
`;
const migration2 = `
CREATE TABLE dashboard_snapshots(account TEXT NOT NULL, scope_key TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(account,scope_key)) STRICT;
CREATE INDEX dashboard_snapshots_updated ON dashboard_snapshots(updated);
`;
const migration3 = `
CREATE TABLE mail_sync_messages(account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, generation TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(account,id)) STRICT;
CREATE INDEX mail_sync_messages_account_updated ON mail_sync_messages(account,updated);
CREATE TABLE mail_sync_state(account TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL) STRICT;
CREATE TABLE mail_sync_leases(account TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL) STRICT;
`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  }
  migrate() {
    this.transaction(() => {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 3) throw new AppError("INTERNAL_ERROR");
      if (version === 0) {
        this.db.exec(migration1);
        this.db.exec("PRAGMA user_version=1");
      }
      const current = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (current === 1) {
        this.db.exec(migration2);
        this.db.exec("PRAGMA user_version=2");
      }
      const afterSnapshots = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
      );
      if (afterSnapshots === 2) {
        this.db.exec(migration3);
        this.db.exec("PRAGMA user_version=3");
      }
    });
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  policy(account: string, sender: string): SenderPolicy | undefined {
    const row = this.db
      .prepare("SELECT * FROM sender_policies WHERE account=? AND sender=?")
      .get(account, sender);
    return row
      ? {
          accountId: account,
          sender,
          detectionEnabled: row.enabled === 1,
          updatedAt: String(row.updated),
          source: "USER",
        }
      : undefined;
  }
  setPolicy(p: SenderPolicy) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sender_policies VALUES(?,?,?,?) ON CONFLICT(account,sender) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated",
        )
        .run(p.accountId, p.sender, Number(p.detectionEnabled), p.updatedAt);
      this.audit(p.accountId, "SENDER_POLICY_CHANGED", {
        result: p.detectionEnabled ? "DETECT" : "IGNORE",
      });
    });
  }
  private assertNoUncertainOverlap(p: CleanupPreview) {
    const rows = this.db
      .prepare(
        "SELECT id, data FROM cleanup_previews WHERE account=? AND id<>? AND status IN ('EXECUTING','UNCERTAIN')",
      )
      .all(p.accountId, p.id);
    for (const row of rows) {
      const other = JSON.parse(String(row.data)) as CleanupPreview;
      if (other.messageIds.some((id) => p.messageIds.includes(id)))
        throw new AppError("MAILBOX_CHANGED");
    }
  }
  savePreview(p: CleanupPreview) {
    this.transaction(() => {
      this.assertNoUncertainOverlap(p);
      this.db
        .prepare("INSERT INTO cleanup_previews(id,account,data,status) VALUES(?,?,?,?)")
        .run(p.id, p.accountId, JSON.stringify(p), p.status);
      this.audit(p.accountId, "CLEANUP_PREVIEW_CREATED", {
        previewId: p.id,
        count: p.messageCount,
      });
    });
  }
  private row(account: string, id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM cleanup_previews WHERE account=? AND id=?")
      .get(account, id);
    if (!row) throw new AppError("NOT_FOUND");
    return row;
  }
  preview(account: string, id: string): CleanupPreview {
    const row = this.row(account, id);
    return {
      ...(JSON.parse(String(row.data)) as CleanupPreview),
      status: row.status as PreviewStatus,
    };
  }
  pending(account: string): CleanupPreview[] {
    return this.db
      .prepare(
        "SELECT id FROM cleanup_previews WHERE account=? AND status IN ('PENDING','CONFIRMED','EXECUTING','UNCERTAIN') ORDER BY rowid DESC LIMIT 30",
      )
      .all(account)
      .map((r) => this.preview(account, String(r.id)));
  }
  confirmProtected(account: string, id: string, now: string): CleanupPreview {
    return this.transaction(() => {
      const p = this.preview(account, id);
      if (p.expiresAt <= now) throw new AppError("CONFIRMATION_EXPIRED");
      if (p.status !== "PENDING" || !p.requiresProtectedConfirmation)
        throw new AppError("VALIDATION_ERROR");
      if (p.protectedConfirmedAt) throw new AppError("CONFIRMATION_ALREADY_USED");
      const updated = { ...p, protectedConfirmedAt: now };
      this.db
        .prepare("UPDATE cleanup_previews SET data=? WHERE account=? AND id=?")
        .run(JSON.stringify(updated), account, id);
      this.audit(account, "PROTECTED_SCOPE_CONFIRMED", {
        previewId: id,
        count: p.messageCount,
      });
      return updated;
    });
  }
  confirm(account: string, id: string, hash: string, expiry: string, now: string) {
    this.transaction(() => {
      const p = this.preview(account, id);
      if (p.expiresAt <= now) throw new AppError("CONFIRMATION_EXPIRED");
      if (p.status === "CANCELLED") throw new AppError("CANCELLED");
      if (p.status !== "PENDING") throw new AppError("CONFIRMATION_ALREADY_USED");
      if (p.requiresProtectedConfirmation && !p.protectedConfirmedAt)
        throw new AppError("PROTECTED_CONFIRMATION_REQUIRED");
      this.db
        .prepare(
          "UPDATE cleanup_previews SET status='CONFIRMED',token_hash=?,token_expiry=? WHERE account=? AND id=?",
        )
        .run(hash, expiry, account, id);
      this.audit(account, "CLEANUP_CONFIRMED", { previewId: id, count: p.messageCount });
    });
  }
  claim(account: string, id: string, hash: string, now: string): CleanupPreview {
    return this.transaction(() => {
      const row = this.row(account, id);
      const p = this.preview(account, id);
      if (row.cancelled === 1) throw new AppError("CANCELLED");
      if (row.consumed === 1) throw new AppError("CONFIRMATION_ALREADY_USED");
      if (!row.token_hash || row.token_hash !== hash) throw new AppError("CONFIRMATION_REQUIRED");
      if (String(row.token_expiry) <= now || p.expiresAt <= now)
        throw new AppError("CONFIRMATION_EXPIRED");
      if (p.status !== "CONFIRMED") throw new AppError("CONFIRMATION_REQUIRED");
      this.assertNoUncertainOverlap(p);
      this.db
        .prepare(
          "UPDATE cleanup_previews SET consumed=1,status='EXECUTING' WHERE account=? AND id=?",
        )
        .run(account, id);
      this.audit(account, "CLEANUP_STARTED", { previewId: id, count: p.messageCount });
      return p;
    });
  }
  cancelled(account: string, id: string) {
    return this.row(account, id).cancelled === 1;
  }
  cancel(account: string, id: string) {
    this.transaction(() => {
      const p = this.preview(account, id);
      if (["COMPLETED", "PARTIAL"].includes(p.status))
        throw new AppError("CONFIRMATION_ALREADY_USED");
      this.db
        .prepare(
          "UPDATE cleanup_previews SET cancelled=1,status=CASE WHEN status IN ('EXECUTING','UNCERTAIN') THEN status ELSE 'CANCELLED' END,token_hash=NULL WHERE account=? AND id=?",
        )
        .run(account, id);
      this.audit(account, "CLEANUP_CANCELLED", { previewId: id });
    });
  }
  recordOutcome(account: string, id: string, messageId: string, outcome: Outcome) {
    const p = this.preview(account, id);
    if (!p.messageIds.includes(messageId)) throw new AppError("PERMISSION_DENIED");
    this.db
      .prepare(
        "INSERT INTO cleanup_outcomes VALUES(?,?,?) ON CONFLICT(preview_id,message_id) DO UPDATE SET outcome=excluded.outcome",
      )
      .run(id, messageId, outcome);
  }
  outcomes(account: string, id: string): Record<string, Outcome> {
    this.row(account, id);
    return Object.fromEntries(
      this.db
        .prepare("SELECT message_id,outcome FROM cleanup_outcomes WHERE preview_id=?")
        .all(id)
        .map((r) => [String(r.message_id), r.outcome as Outcome]),
    );
  }
  finish(account: string, id: string, status: PreviewStatus) {
    this.transaction(() => {
      this.row(account, id);
      this.db
        .prepare("UPDATE cleanup_previews SET status=? WHERE account=? AND id=?")
        .run(status, account, id);
      const moved = Object.values(this.outcomes(account, id)).filter((x) => x === "MOVED").length;
      this.audit(account, status === "COMPLETED" ? "CLEANUP_EXECUTED" : "CLEANUP_FAILED", {
        previewId: id,
        count: moved,
        result: status,
      });
    });
  }
  audit(
    account: string,
    action: string,
    d: { previewId?: string; count?: number; result?: string } = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO audit_events(timestamp,action,account,preview_id,count,result) VALUES(?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        action,
        account,
        d.previewId ?? null,
        d.count ?? null,
        d.result ?? null,
      );
  }
  audits(account: string, limit: number): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM audit_events WHERE account=? ORDER BY id DESC LIMIT ?")
      .all(account, limit)
      .map((r) => ({
        id: Number(r.id),
        timestamp: String(r.timestamp),
        action: String(r.action),
        accountId: account,
        ...(r.preview_id ? { previewId: String(r.preview_id) } : {}),
        ...(r.count !== null ? { count: Number(r.count) } : {}),
        ...(r.result ? { result: String(r.result) } : {}),
      }));
  }
  dashboardSnapshot(account: string, scopeKey: string): DashboardSnapshot | undefined {
    const row = this.db
      .prepare("SELECT data FROM dashboard_snapshots WHERE account=? AND scope_key=?")
      .get(account, scopeKey);
    if (!row) return undefined;
    try {
      const snapshot = JSON.parse(String(row.data)) as DashboardSnapshot;
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.accountId !== account ||
        snapshot.scopeKey !== scopeKey ||
        !snapshot.scan ||
        !Array.isArray(snapshot.groups) ||
        !Array.isArray(snapshot.messages) ||
        !snapshot.reports?.["7"] ||
        !snapshot.reports?.["30"] ||
        !snapshot.reports?.["90"]
      )
        return undefined;
      return snapshot;
    } catch {
      return undefined;
    }
  }
  saveDashboardSnapshot(snapshot: DashboardSnapshot) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO dashboard_snapshots(account,scope_key,data,updated) VALUES(?,?,?,?) ON CONFLICT(account,scope_key) DO UPDATE SET data=excluded.data,updated=excluded.updated",
        )
        .run(snapshot.accountId, snapshot.scopeKey, JSON.stringify(snapshot), snapshot.generatedAt);
    });
  }
  syncState(account: string): MailSyncState | undefined {
    const row = this.db.prepare("SELECT data FROM mail_sync_state WHERE account=?").get(account);
    if (!row) return undefined;
    try {
      const state = JSON.parse(String(row.data)) as MailSyncState;
      if (
        state.accountId !== account ||
        !["full", "incremental"].includes(state.mode) ||
        !["idle", "syncing", "cooling_down", "completed", "failed"].includes(state.status) ||
        !Number.isInteger(state.processedCount) ||
        state.processedCount < 0
      )
        return undefined;
      return state;
    } catch {
      return undefined;
    }
  }
  saveSyncPage(state: MailSyncState, upserts: MailMessage[], deletedIds: string[]) {
    this.transaction(() => {
      const upsert = this.db.prepare(
        "INSERT INTO mail_sync_messages(account,id,data,generation,updated) VALUES(?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET data=excluded.data,generation=excluded.generation,updated=excluded.updated",
      );
      for (const message of upserts) {
        if (message.accountId !== state.accountId) throw new AppError("PERMISSION_DENIED");
        upsert.run(
          state.accountId,
          message.id,
          JSON.stringify(message),
          state.generation,
          state.updatedAt,
        );
      }
      const remove = this.db.prepare("DELETE FROM mail_sync_messages WHERE account=? AND id=?");
      for (const id of new Set(deletedIds)) remove.run(state.accountId, id);
      if (state.mode === "full" && state.status === "completed")
        this.db
          .prepare("DELETE FROM mail_sync_messages WHERE account=? AND generation<>?")
          .run(state.accountId, state.generation);
      this.db
        .prepare(
          "INSERT INTO mail_sync_state(account,data,updated) VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data,updated=excluded.updated",
        )
        .run(state.accountId, JSON.stringify(state), state.updatedAt);
    });
  }
  syncMessages(account: string, limit: number): MailMessage[] {
    return this.db
      .prepare(
        "SELECT data FROM mail_sync_messages WHERE account=? ORDER BY json_extract(data,'$.date') DESC,id LIMIT ?",
      )
      .all(account, limit)
      .flatMap((row) => {
        try {
          const message = JSON.parse(String(row.data)) as MailMessage;
          return message.accountId === account ? [message] : [];
        } catch {
          return [];
        }
      });
  }
  acquireSyncLease(account: string, owner: string, expiresAt: string, now: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "INSERT INTO mail_sync_leases(account,owner,expires_at) VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mail_sync_leases.expires_at<=? OR mail_sync_leases.owner=excluded.owner",
        )
        .run(account, owner, expiresAt, now);
      return Number(result.changes) === 1;
    });
  }
  renewSyncLease(account: string, owner: string, expiresAt: string) {
    this.db
      .prepare("UPDATE mail_sync_leases SET expires_at=? WHERE account=? AND owner=?")
      .run(expiresAt, account, owner);
  }
  releaseSyncLease(account: string, owner: string) {
    this.db.prepare("DELETE FROM mail_sync_leases WHERE account=? AND owner=?").run(account, owner);
  }
  prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM cleanup_previews WHERE status NOT IN ('EXECUTING','UNCERTAIN') AND json_extract(data,'$.createdAt')<?",
        )
        .run(cutoff);
      this.db
        .prepare(
          "DELETE FROM audit_events WHERE timestamp<? AND (preview_id IS NULL OR preview_id NOT IN (SELECT id FROM cleanup_previews WHERE status IN ('EXECUTING','UNCERTAIN')))",
        )
        .run(cutoff);
      this.db.prepare("DELETE FROM dashboard_snapshots WHERE updated<?").run(cutoff);
    });
  }
}
