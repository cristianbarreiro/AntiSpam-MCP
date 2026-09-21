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
  | "TRANSACTION"
  | "STARRED";
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
  resultSizeEstimate?: number;
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
export interface MessageClassification {
  messageId: MessageId;
  classification: Classification;
  confidence: number;
  spamScore: number;
  reasons: string[];
  protections: ("IMPORTANT" | "TRANSACTIONAL" | "STARRED")[];
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
  presentationClassification: Classification | "MIXED";
  classificationBreakdown: Partial<Record<Classification, number>>;
  detectionEnabled: boolean;
  candidate: boolean;
}
export interface SenderNoiseMetric extends SenderGroup {
  messagesLast7Days: number;
  messagesLast30Days: number;
  messagesLast90Days: number;
  observableMessagesPer30Days: number;
}
export interface MailboxNoiseReport {
  accountId: ProviderAccountId;
  windowDays: 7 | 30 | 90;
  sampledAt: string;
  totalScanned: number;
  totalInWindow: number;
  complete: boolean;
  coverage: string;
  senders: SenderNoiseMetric[];
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
  sender?: SenderAddress;
  messageIds: MessageId[];
  messageCount: number;
  unreadCount: number;
  oldestMessageAt: string;
  latestMessageAt: string;
  action: "MOVE_TO_TRASH";
  createdAt: string;
  expiresAt: string;
  status: PreviewStatus;
  items?: FrozenCleanupItem[];
  senders?: CleanupSenderSummary[];
  warnings?: string[];
  requiresProtectedConfirmation?: boolean;
  protectedConfirmedAt?: string;
}
export interface FrozenCleanupItem {
  id: MessageId;
  sender: SenderAddress;
  classification: Classification;
  protections: MessageClassification["protections"];
  allowIgnored?: boolean;
}
export interface CleanupSenderSummary {
  sender: SenderAddress;
  messageCount: number;
  unreadCount: number;
  classificationBreakdown: Partial<Record<Classification, number>>;
}
export interface CleanupCriteria {
  after?: string;
  before?: string;
  readState?: "READ" | "UNREAD";
  classifications?: Classification[];
  includeProtected?: ("IMPORTANT" | "TRANSACTIONAL" | "STARRED")[];
  includeIgnored?: boolean;
}
export interface CleanupSelection {
  sender: SenderAddress;
  messageIds?: MessageId[];
  criteria?: CleanupCriteria;
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
  alreadyTrashed: number;
  remaining: number;
  bySender: Array<{
    sender: SenderAddress;
    moved: number;
    failed: number;
    uncertain: number;
    alreadyTrashed: number;
    remaining: number;
  }>;
}
export type Outcome = "MOVED" | "FAILED" | "UNCERTAIN" | "ALREADY_TRASHED";
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
  requestedLimit: number;
  scannedMessages: number;
  senderCount: number;
  complete: boolean;
  generatedAt: string;
  classificationSummary: Partial<Record<Classification, number>>;
}

export type DashboardJobStage =
  | "idle"
  | "connecting"
  | "restoring_cache"
  | "fetching"
  | "processing"
  | "classifying"
  | "persisting"
  | "preparing_view"
  | "ready"
  | "refreshing"
  | "error"
  | "cancelled";

export interface DashboardMessage {
  id: MessageId;
  sender: MailSender;
  subject: string;
  date: string;
  unread: boolean;
  signals: Signal[];
  classification: MessageClassification;
}

export interface DashboardSnapshot {
  schemaVersion: 1;
  datasetVersion: string;
  accountId: ProviderAccountId;
  scopeKey: string;
  requestedLimit: number;
  generatedAt: string;
  scan: MailboxScanResult;
  groups: SenderGroup[];
  reports: Record<"7" | "30" | "90", MailboxNoiseReport>;
  messages: DashboardMessage[];
}

export interface DashboardJobStatus {
  jobId: string;
  accountKey: ProviderAccountId;
  scopeKey: string;
  datasetVersion?: string;
  stage: DashboardJobStage;
  processed: number;
  total: number | null;
  percent: number | null;
  coverage: "complete" | "partial" | "unknown";
  ready: boolean;
  source: "none" | "cache" | "live";
  startedAt: string;
  updatedAt: string;
  error?: { code: string; message: string; retryable: boolean };
}
