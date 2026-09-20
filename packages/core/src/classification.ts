import type {
  Classification,
  ClassificationResult,
  MailMessage,
  MessageClassification,
} from "./domain.js";

function result(
  messageId: string,
  classification: Classification,
  confidence: number,
  spamScore: number,
  reasons: string[],
  protections: MessageClassification["protections"] = [],
): MessageClassification {
  return { messageId, classification, confidence, spamScore, reasons, protections };
}

export function classifyMessage(message: MailMessage): MessageClassification {
  const has = (signal: MailMessage["signals"][number]) => message.signals.includes(signal);
  const protections: MessageClassification["protections"] = [];
  if (has("IMPORTANT")) protections.push("IMPORTANT");
  if (has("TRANSACTION")) protections.push("TRANSACTIONAL");
  if (has("STARRED")) protections.push("STARRED");

  if (has("IMPORTANT"))
    return result(
      message.id,
      "IMPORTANT",
      0.95,
      0.02,
      ["Marcado como importante por el proveedor"],
      protections,
    );
  if (has("TRANSACTION"))
    return result(
      message.id,
      "TRANSACTIONAL",
      0.85,
      0.05,
      ["Señal transaccional del proveedor"],
      protections,
    );
  if (has("SPAM"))
    return result(
      message.id,
      "SPAM",
      0.9,
      0.9,
      ["Señal de spam del proveedor; no autoriza una limpieza"],
      protections,
    );
  if (has("PROMOTION"))
    return result(
      message.id,
      "PROMOTIONAL",
      has("UNSUBSCRIBE") ? 0.9 : 0.75,
      0.25,
      [
        "Señal de promoción del proveedor",
        ...(has("UNSUBSCRIBE") ? ["Cabecera List-Unsubscribe presente"] : []),
      ],
      protections,
    );
  if (has("LIST"))
    return result(
      message.id,
      "NEWSLETTER",
      0.85,
      0.15,
      ["Cabecera de lista de correo presente"],
      protections,
    );
  if (has("AUTOMATED"))
    return result(
      message.id,
      "NOTIFICATION",
      0.7,
      0.1,
      ["Cabecera de mensaje automático presente"],
      protections,
    );
  return result(
    message.id,
    "UNKNOWN",
    0.2,
    0.2,
    ["No hay evidencia determinista suficiente"],
    protections,
  );
}

export function classify(messages: readonly MailMessage[], enabled = true): ClassificationResult {
  const grouped = (
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
  if (!enabled) return grouped("UNKNOWN", 1, 0, "El usuario desactivó la detección de ruido");

  const classified = messages.map(classifyMessage);
  const has = (category: Classification) =>
    classified.some((item) => item.classification === category);
  if (has("IMPORTANT"))
    return grouped(
      "IMPORTANT",
      0.95,
      0.02,
      "Hay mensajes importantes protegidos; consulte el desglose por mensaje",
    );
  if (has("SPAM")) return grouped("SPAM", 0.9, 0.9, "Hay señales de spam del proveedor");
  if (has("TRANSACTIONAL"))
    return grouped("TRANSACTIONAL", 0.85, 0.05, "Hay mensajes transaccionales protegidos");
  if (has("PROMOTIONAL"))
    return grouped("PROMOTIONAL", 0.8, 0.25, "Hay mensajes promocionales observados");
  if (has("NEWSLETTER"))
    return grouped("NEWSLETTER", 0.85, 0.15, "Hay mensajes de listas de correo");
  if (
    has("NOTIFICATION") &&
    messages.some((m) => m.signals.includes("UNSUBSCRIBE")) &&
    messages.length >= 20 &&
    messages.filter((m) => m.unread).length / messages.length >= 0.8
  )
    return grouped(
      "SUSPECTED_SPAM",
      0.6,
      0.6,
      "Tráfico automático con suscripción, volumen alto y mayoría sin leer",
    );
  if (has("NOTIFICATION"))
    return grouped("NOTIFICATION", 0.7, 0.1, "Hay mensajes automáticos observados");
  return grouped("UNKNOWN", 0.2, 0.2, "No hay evidencia determinista suficiente");
}
