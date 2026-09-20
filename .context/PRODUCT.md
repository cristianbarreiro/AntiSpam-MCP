# Product

Status: canonical behavior; differential P0 with limits documented in README.

Mailbox owners inspect spam, suspected spam, promotional/newsletter traffic,
notifications and high-volume senders through MCP or a local dashboard.
Group by sender within the connected account; show display name/address, total,
unread/read counts, oldest/latest dates, classification, confidence and detection
preference. Expand a sender to fetch paginated subjects/dates/read state on demand.
Expose scan bounds and freshness; high volume alone does not imply spam.

Categories: IMPORTANT, TRANSACTIONAL, NOTIFICATION, NEWSLETTER, PROMOTIONAL,
SUSPECTED_SPAM, SPAM, UNKNOWN. Generic provider/header signals produce explicit
Spanish reasons with no LLM dependency. Classification occurs per message; a sender
with multiple categories is presented as MIXED with a breakdown. Importance,
transactional state and starred state protect that message without hiding promotional
peers. Volume or unread ratio alone never proves spam.

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
New cleanup plans support typed date/read/category/ID selection across up to 20
senders and 1000 frozen IDs. They exclude protected and ignored scope by default.
