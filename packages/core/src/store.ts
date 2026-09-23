import type {
  AuditEvent,
  CleanupPreview,
  DashboardSnapshot,
  MailMessage,
  MailSyncState,
  Outcome,
  PreviewStatus,
  SenderPolicy,
} from "./domain.js";
export interface Store {
  policy(account: string, sender: string): SenderPolicy | undefined;
  setPolicy(policy: SenderPolicy): void;
  savePreview(preview: CleanupPreview): void;
  preview(account: string, id: string): CleanupPreview;
  pending(account: string): CleanupPreview[];
  confirmProtected(account: string, id: string, now: string): CleanupPreview;
  confirm(account: string, id: string, tokenHash: string, expiresAt: string, now: string): void;
  claim(account: string, id: string, tokenHash: string, now: string): CleanupPreview;
  cancelled(account: string, id: string): boolean;
  cancel(account: string, id: string): void;
  recordOutcome(account: string, id: string, messageId: string, outcome: Outcome): void;
  outcomes(account: string, id: string): Record<string, Outcome>;
  finish(account: string, id: string, status: PreviewStatus): void;
  audit(
    account: string,
    action: string,
    details?: { previewId?: string; count?: number; result?: string },
  ): void;
  audits(account: string, limit: number): AuditEvent[];
  dashboardSnapshot(account: string, scopeKey: string): DashboardSnapshot | undefined;
  saveDashboardSnapshot(snapshot: DashboardSnapshot): void;
  syncState(account: string): MailSyncState | undefined;
  saveSyncPage(state: MailSyncState, upserts: MailMessage[], deletedIds: string[]): void;
  syncMessages(account: string, limit: number): MailMessage[];
  acquireSyncLease(account: string, owner: string, expiresAt: string, now: string): boolean;
  renewSyncLease(account: string, owner: string, expiresAt: string): void;
  releaseSyncLease(account: string, owner: string): void;
}
