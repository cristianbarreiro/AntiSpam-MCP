export const classifications = [
  "IMPORTANT",
  "TRANSACTIONAL",
  "NOTIFICATION",
  "NEWSLETTER",
  "PROMOTIONAL",
  "SUSPECTED_SPAM",
  "SPAM",
  "UNKNOWN",
] as const;
export type Classification = (typeof classifications)[number];
export type MessageId = string;
export type ProviderAccountId = string;
export type SenderAddress = string;
export interface MailAccount {
  id: ProviderAccountId;
  provider: string;
  email: string;
}
export interface MailSender {
  email: SenderAddress;
  original: string;
  displayName: string;
}
export type Signal =
  | "SPAM"
  | "IMPORTANT"
  | "PROMOTION"
  | "LIST"
  | "UNSUBSCRIBE"
  | "AUTOMATED"
  | "TRANSACTION";
export interface MailMessage {
  id: MessageId;
  accountId: ProviderAccountId;
  sender: MailSender;
  subject: string;
  date: string;
  unread: boolean;
  trashed: boolean;
  signals: Signal[];
}
export interface Page<T> {
  items: T[];
  cursor?: string;
}
export interface PageInput {
  limit: number;
  cursor?: string;
  sender?: SenderAddress;
}
export interface MailProvider {
  getAccountInfo(): Promise<MailAccount>;
  scanMessages(input: PageInput): Promise<Page<MailMessage>>;
  getMessageMetadata(id: MessageId): Promise<MailMessage>;
  moveToTrash(id: MessageId): Promise<void>;
}
export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  spamScore: number;
  reasons: string[];
  source: "RULE_ENGINE" | "USER";
}
export interface SenderGroup {
  sender: MailSender;
  accountId: ProviderAccountId;
  messageCount: number;
  unreadCount: number;
  readCount: number;
  oldestMessageAt: string;
  latestMessageAt: string;
  readStatus: "READ" | "UNREAD" | "MIXED";
  classification: ClassificationResult;
  detectionEnabled: boolean;
  candidate: boolean;
}
export interface SenderPolicy {
  sender: SenderAddress;
  accountId: ProviderAccountId;
  detectionEnabled: boolean;
  updatedAt: string;
  source: "USER";
}
export type PreviewStatus =
  | "PENDING"
  | "CONFIRMED"
  | "EXECUTING"
  | "COMPLETED"
  | "PARTIAL"
  | "CANCELLED"
  | "UNCERTAIN";
export interface CleanupPreview {
  id: string;
  accountId: ProviderAccountId;
  sender: SenderAddress;
  messageIds: MessageId[];
  messageCount: number;
  unreadCount: number;
  oldestMessageAt: string;
  latestMessageAt: string;
  action: "MOVE_TO_TRASH";
  createdAt: string;
  expiresAt: string;
  status: PreviewStatus;
}
export interface CleanupConfirmation {
  token: string;
  previewId: string;
  expiresAt: string;
}
export interface CleanupResult {
  previewId: string;
  status: PreviewStatus;
  moved: number;
  failed: number;
  uncertain: number;
  remaining: number;
}
export type Outcome = "MOVED" | "FAILED" | "UNCERTAIN";
export interface AuditEvent {
  id: number;
  timestamp: string;
  action: string;
  accountId: string;
  previewId?: string;
  count?: number;
  result?: string;
}
export interface MailboxScanResult {
  scannedMessages: number;
  senderCount: number;
  complete: boolean;
  generatedAt: string;
  classificationSummary: Partial<Record<Classification, number>>;
}
