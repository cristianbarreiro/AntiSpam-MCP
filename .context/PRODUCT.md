# Product

Status: canonical behavior; Phase 1 implementation with limits documented in README.

Mailbox owners inspect spam, suspected spam, promotional/newsletter traffic,
notifications and high-volume senders through MCP or a local dashboard.
Group by sender within the connected account; show display name/address, total,
unread/read counts, oldest/latest dates, classification, confidence and detection
preference. Expand a sender to fetch paginated subjects/dates/read state on demand.
Expose scan bounds and freshness; high volume alone does not imply spam.

Categories: IMPORTANT, TRANSACTIONAL, NOTIFICATION, NEWSLETTER, PROMOTIONAL,
SUSPECTED_SPAM, SPAM, UNKNOWN. Phase 1 uses generic provider/header signals and
explicit reasons, with no LLM dependency. Importance protects the whole group;
otherwise spam, transactional, promotional, mailing-list and automated evidence
are considered in order. Volume/unread ratio requires multiple additional signals.

User detection overrides win. IGNORE removes unwanted-mail candidacy and automatic
classification, but the sender remains inspectable through includeIgnored. DETECT
restores analysis of cached metadata without a provider mutation. A user may still
explicitly preview any sender, including ignored or important senders; candidacy
never constitutes permission to clean up.

Analyze → recommend → preview → explicit human confirmation → execute → audit.
The dashboard uses Review, a concrete message-count/date-range dialog, and a
button naming the Trash effect. Users may cancel or approve for MCP instead.
Show empty/error/loading, partial scan, failed/uncertain cleanup and success states.
Confirmation and recovery guarantees belong to SECURITY; retention belongs to DATA.
