import type { Classification, ClassificationResult, MailMessage } from "./domain.js";
export function classify(messages: readonly MailMessage[], enabled = true): ClassificationResult {
  const result = (classification: Classification, confidence: number, spamScore: number, ...reasons: string[]): ClassificationResult => ({ classification, confidence, spamScore, reasons, source: enabled ? "RULE_ENGINE" : "USER" });
  if (!enabled) return result("UNKNOWN", 1, 0, "User disabled unwanted-mail detection");
  const has = (signal: MailMessage["signals"][number]) => messages.some(m => m.signals.includes(signal));
  if (has("IMPORTANT")) return result("IMPORTANT", .95, .02, "Provider importance signal protects this mixed sender group");
  if (has("SPAM")) return result("SPAM", .9, .9, "Provider spam signal; not a deletion authorization");
  if (has("TRANSACTION")) return result("TRANSACTIONAL", .85, .05, "Provider transactional signal");
  if (has("PROMOTION")) return result("PROMOTIONAL", has("UNSUBSCRIBE") ? .9 : .75, .25, "Provider promotion signal", ...(has("UNSUBSCRIBE") ? ["Unsubscribe header present"] : []));
  if (has("LIST")) return result("NEWSLETTER", .85, .15, "Mailing-list header present");
  if (has("AUTOMATED") && has("UNSUBSCRIBE") && messages.length >= 20 && messages.filter(m => m.unread).length / messages.length >= .8) return result("SUSPECTED_SPAM", .6, .6, "Automated subscription traffic with high volume and unread ratio");
  if (has("AUTOMATED")) return result("NOTIFICATION", .7, .1, "Automated-message header present");
  return result("UNKNOWN", .2, .2, "Insufficient deterministic evidence");
}
