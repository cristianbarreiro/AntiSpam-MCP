# Domain and glossary

Status: canonical vocabulary. Concrete types live in packages/core/src/domain.ts.

| Term | Meaning |
| --- | --- |
| MailProvider | Account-bound metadata, paging and moveToTrash capability; no permanent-delete method |
| MailAccount / ProviderAccountId | Provider plus account identity; isolation boundary |
| MailSender | Original address, normalized address and display name |
| MailMessage | Message ID, account, sender, subject, timestamp, read/trash state and generic signals |
| SenderGroup | Account-scoped sender counts, read state, date range, classification and candidacy |
| ClassificationResult | Category, confidence, heuristic spam score, reasons and RULE_ENGINE/USER source |
| SenderPolicy / DetectionOverride | Persistent user DETECT/IGNORE choice, represented by detectionEnabled |
| Allowlist | View of detection-disabled sender policies, not another identity system |
| CleanupPreview | Frozen account/sender/action/message IDs and summary with expiry |
| CleanupConfirmation | Short-lived single-use evidence of a human-approved preview |
| CleanupOperation / CleanupResult | Preview execution state plus per-message outcomes and compact totals |
| AuditEvent | Minimal timestamped action, account, count, operation reference and result |
| MailboxScanResult / ScanState | Bounded scope, count, freshness and completeness; ephemeral in Phase 1 |

Normalization trims whitespace, parses simple display-name/address forms, lowercases
the domain, preserves local-part case and aliases. No domain-wide or cross-account
merging. Complex RFC address forms and encoded display-name decoding remain limited.
Display names never establish identity. Provider labels become generic signals.

Spam is unwanted mail; suspected spam records uncertainty. Promotions/newsletters
are not automatically spam. Confidence and spam score are heuristic values, not
calibrated probabilities or authority. Mixed groups preserve importance protection;
inspect individual metadata before cleanup. Categories are owned by PRODUCT.
Cleanup means approved Trash movement. Trash is distinct from permanent deletion.
