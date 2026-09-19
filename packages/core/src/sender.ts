import type { MailSender } from "./domain.js";
import { AppError } from "./errors.js";
export function normalizeAddress(value: string): string {
  const email = value.trim();
  if (email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email)) throw new AppError("VALIDATION_ERROR");
  const at = email.lastIndexOf("@");
  // Preserve local-part case and aliases: providers may distinguish them.
  return email.slice(0, at) + "@" + email.slice(at + 1).toLowerCase();
}
export function parseSender(value: string): MailSender {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  const original = (match?.[2] ?? value).trim();
  return { original, email: normalizeAddress(original), displayName: (match?.[1] ?? "").replace(/^"|"$/g, "").slice(0, 256) };
}
