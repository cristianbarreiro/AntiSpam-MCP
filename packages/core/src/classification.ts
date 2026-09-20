import type { Classification, ClassificationResult, MailMessage } from "./domain.js";
export function classify(messages: readonly MailMessage[], enabled = true): ClassificationResult {
  const result = (
    classification: Classification,
    confidence: number,
    spamScore: number,
    ...reasons: string[]
  ): ClassificationResult => ({
    classification,
    confidence,
    spamScore,
    reasons,
    source: enabled ? "RULE_ENGINE" : "USER",
  });
  if (!enabled) return result("UNKNOWN", 1, 0, "User disabled unwanted-mail detection");
  const has = (signal: MailMessage["signals"][number]) =>
    messages.some((m) => m.signals.includes(signal));
  if (has("IMPORTANT"))
    return result(
      "IMPORTANT",
      0.95,
      0.02,
      "Provider importance signal protects this mixed sender group",
    );
  if (has("SPAM"))
    return result("SPAM", 0.9, 0.9, "Provider spam signal; not a deletion authorization");
  if (has("TRANSACTION"))
    return result("TRANSACTIONAL", 0.85, 0.05, "Provider transactional signal");
  if (has("PROMOTION"))
    return result(
      "PROMOTIONAL",
      has("UNSUBSCRIBE") ? 0.9 : 0.75,
      0.25,
      "Provider promotion signal",
      ...(has("UNSUBSCRIBE") ? ["Unsubscribe header present"] : []),
    );
  if (has("LIST")) return result("NEWSLETTER", 0.85, 0.15, "Mailing-list header present");
  if (
    has("AUTOMATED") &&
    has("UNSUBSCRIBE") &&
    messages.length >= 20 &&
    messages.filter((m) => m.unread).length / messages.length >= 0.8
  )
    return result(
      "SUSPECTED_SPAM",
      0.6,
      0.6,
      "Automated subscription traffic with high volume and unread ratio",
    );
  if (has("AUTOMATED")) return result("NOTIFICATION", 0.7, 0.1, "Automated-message header present");
  return result("UNKNOWN", 0.2, 0.2, "Insufficient deterministic evidence");
}
