import type { AuditEvent, CleanupPreview, Outcome, PreviewStatus, SenderPolicy } from "./domain.js";
export interface Store {
  policy(account: string, sender: string): SenderPolicy | undefined;
  setPolicy(policy: SenderPolicy): void;
  savePreview(preview: CleanupPreview): void;
  preview(account: string, id: string): CleanupPreview;
  pending(account: string): CleanupPreview[];
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
}
