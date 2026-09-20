import { classify, classifyMessage } from "./classification.js";
import type { Classification, MailMessage, SenderGroup } from "./domain.js";
export function aggregate(
  messages: readonly MailMessage[],
  enabled: (account: string, sender: string) => boolean,
): SenderGroup[] {
  const groups = new Map<string, MailMessage[]>();
  for (const m of messages) {
    if (m.trashed) continue;
    const key = JSON.stringify([m.accountId, m.sender.email]);
    const group = groups.get(key) ?? [];
    if (!group.some((other) => other.id === m.id)) group.push(m);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) throw new Error("Empty group");
    const unreadCount = group.filter((m) => m.unread).length;
    const detectionEnabled = enabled(first.accountId, first.sender.email);
    const classification = classify(group, detectionEnabled);
    const classificationBreakdown: Partial<Record<Classification, number>> = {};
    for (const message of group.map(classifyMessage))
      classificationBreakdown[message.classification] =
        (classificationBreakdown[message.classification] ?? 0) + 1;
    const observedCategories = Object.keys(classificationBreakdown) as Classification[];
    const presentationClassification =
      observedCategories.length > 1 ? ("MIXED" as const) : (observedCategories[0] ?? "UNKNOWN");
    return {
      sender: last.sender,
      accountId: first.accountId,
      messageCount: group.length,
      unreadCount,
      readCount: group.length - unreadCount,
      oldestMessageAt: first.date,
      latestMessageAt: last.date,
      readStatus:
        unreadCount === 0
          ? ("READ" as const)
          : unreadCount === group.length
            ? ("UNREAD" as const)
            : ("MIXED" as const),
      classification,
      presentationClassification,
      classificationBreakdown,
      detectionEnabled,
      candidate:
        detectionEnabled &&
        ["SPAM", "SUSPECTED_SPAM", "PROMOTIONAL", "NEWSLETTER"].some(
          (category) => (classificationBreakdown[category as Classification] ?? 0) > 0,
        ),
    };
  });
}
