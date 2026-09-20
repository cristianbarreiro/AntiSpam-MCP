export type ErrorCode =
  | "AUTHENTICATION_ERROR"
  | "PERMISSION_DENIED"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_ALREADY_USED"
  | "PROTECTED_CONFIRMATION_REQUIRED"
  | "MAILBOX_CHANGED"
  | "CANCELLED"
  | "SCAN_REQUIRED"
  | "INTERNAL_ERROR";
const messages: Record<ErrorCode, string> = {
  AUTHENTICATION_ERROR: "Connect or reconnect the provider account.",
  PERMISSION_DENIED: "This action is not authorized.",
  PROVIDER_ERROR: "The provider could not complete the request. Refresh before retrying.",
  RATE_LIMITED: "Provider rate limit reached. Try again later.",
  VALIDATION_ERROR: "Invalid input. Check the supplied fields and limits.",
  NOT_FOUND: "The requested item was not found.",
  CONFIRMATION_REQUIRED: "Approve this preview in the local dashboard first.",
  CONFIRMATION_EXPIRED: "This preview or confirmation expired. Create a new preview.",
  CONFIRMATION_ALREADY_USED: "This confirmation has already been used.",
  PROTECTED_CONFIRMATION_REQUIRED:
    "Confirm the protected-message scope separately in the local dashboard.",
  MAILBOX_CHANGED: "The mailbox selection is incomplete or changed. Create a new preview.",
  CANCELLED: "This cleanup was cancelled.",
  SCAN_REQUIRED: "Scan the mailbox to refresh sender statistics.",
  INTERNAL_ERROR: "An internal operation failed. No automatic retry was attempted.",
};
export class AppError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(messages[code]);
    this.name = "AppError";
  }
}
export function safeError(error: unknown): { code: ErrorCode; message: string } {
  const e = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
  return { code: e.code, message: e.message };
}
