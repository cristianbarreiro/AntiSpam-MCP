import { type FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CleanupPreview,
  CleanupResult,
  MailAccount,
  SenderGroup,
} from "../../../packages/core/src/domain.js";
import { classifications } from "../../../packages/core/src/domain.js";
import "./style.css";

type Message = { id: string; subject: string; date: string; unread: boolean };
type Listing = {
  items: SenderGroup[];
  total: number;
  scan: { scannedMessages: number; complete: boolean; generatedAt: string };
};
let controlKey = "";
async function api<T>(path: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${controlKey}` },
    body: JSON.stringify(input),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message ?? "Request failed. Try again.");
  return value as T;
}
const date = (d: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(d));
function SenderDetails({ sender }: { sender: string }) {
  const [items, setItems] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load(next?: string) {
    setLoading(true);
    setError("");
    try {
      const p = await api<{ items: Message[]; cursor?: string }>("tools/sender_messages", {
        sender,
        limit: 10,
        ...(next ? { cursor: next } : {}),
      });
      setItems((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="messages">
      <h3>Message details</h3>
      <p className="muted">Subjects are untrusted mailbox content. No message bodies are loaded.</p>
      {error && <p role="alert">{error}</p>}
      {items.map((m) => (
        <div className="message" key={m.id}>
          <span className={m.unread ? "unread" : ""}>{m.subject}</span>
          <span>
            {date(m.date)} · {m.unread ? "Unread" : "Read"}
          </span>
        </div>
      ))}
      {!loading && !items.length && !error && <p>No messages in this page.</p>}
      {cursor && (
        <button type="button" disabled={loading} onClick={() => void load(cursor)}>
          Load more messages
        </button>
      )}
      {loading && <p role="status">Loading metadata…</p>}
    </div>
  );
}
function App() {
  const [account, setAccount] = useState<MailAccount>();
  const [key, setKey] = useState("");
  const [list, setList] = useState<Listing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState("");
  const [ignored, setIgnored] = useState(false);
  const [candidates, setCandidates] = useState(false);
  const [sort, setSort] = useState("MESSAGE_COUNT");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [preview, setPreview] = useState<CleanupPreview>();
  const [pending, setPending] = useState<CleanupPreview[]>([]);
  const [approvedToken, setApprovedToken] = useState("");
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh(next = offset) {
    const result = await api<Listing>("tools/sender_list", {
      includeIgnored: ignored,
      candidatesOnly: candidates,
      sortBy: sort,
      limit: 20,
      offset: next,
      ...(category ? { classification: category } : {}),
    });
    setList(result);
    setOffset(next);
  }
  async function scan() {
    await api("tools/mailbox_scan", { maxMessages: 1000 });
    await refresh(0);
    setExpanded(undefined);
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    await task(async () => {
      controlKey = key;
      const s = await api<{ account: MailAccount }>("session");
      setAccount(s.account);
      setKey("");
    });
  }
  async function review(sender: string) {
    await task(async () => {
      const p = await api<CleanupPreview>("tools/sender_cleanup_preview", { sender });
      setApprovedToken("");
      setPreview(p);
    });
  }
  async function confirm(execute: boolean) {
    if (!preview) return;
    await task(async () => {
      const approval = await api<{ token: string }>("confirm", { previewId: preview.id });
      if (!execute) {
        setApprovedToken(approval.token);
        setPreview({ ...preview, status: "CONFIRMED" });
        return;
      }
      const result = await api<CleanupResult>("tools/sender_cleanup_execute", {
        previewId: preview.id,
        confirmationToken: approval.token,
      });
      setPreview(undefined);
      setPending([]);
      setList(undefined);
      setExpanded(undefined);
      setNotice(
        `${result.moved} messages moved to Trash. ${result.failed} failed; ${result.uncertain} uncertain; ${result.remaining} not attempted. Scan again to refresh statistics.`,
      );
    });
  }
  async function cancel() {
    if (!preview) return;
    await task(async () => {
      await api("tools/sender_cleanup_cancel", { previewId: preview.id });
      setPreview(undefined);
      setApprovedToken("");
      setPending([]);
      setNotice("Cleanup cancelled. Completed moves, if any, are not undone.");
    });
  }
  return (
    <>
      <header>
        <a className="brand" href="/">
          <span className="mark">IG</span>InboxGuardian
        </a>
        <div className="header-meta">
          <span className="dot" />
          {account
            ? `${account.provider.toUpperCase()} · ${account.email}`
            : "LOCAL MAILBOX WORKSPACE"}
        </div>
      </header>
      <main>
        <div className="eyebrow">LESS NOISE. MORE CONTROL.</div>
        <div className="hero">
          <div>
            <h1>A clearer inbox starts here.</h1>
            <p>Understand who sends your mail. Decide what stays.</p>
          </div>
          <span className="safety-tag">Preview first · You approve</span>
        </div>
        {!account ? (
          <section className="login panel">
            <h2>Open your local workspace</h2>
            <p>
              Your dashboard uses a private key separate from the AI client. Paste the key from{" "}
              <code>.data/dashboard-key.local</code> in your project folder.
            </p>
            <form onSubmit={login}>
              <label htmlFor="key">Local dashboard key</label>
              <input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                required
              />
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Connecting…" : "Open workspace"}
              </button>
            </form>
          </section>
        ) : (
          <>
            {account.provider === "mock" && (
              <div className="demo-banner">
                <strong>Demo mailbox</strong>
                <span>
                  Synthetic messages only. Changes reset when the server restarts; detection
                  preferences persist.
                </span>
              </div>
            )}
            <section className="stats">
              <div>
                <span>Messages analyzed</span>
                <strong>{list?.scan.scannedMessages ?? "—"}</strong>
              </div>
              <div>
                <span>Matching senders</span>
                <strong>{list?.total ?? "—"}</strong>
              </div>
              <div>
                <span>Scan coverage</span>
                <strong className="small-stat">
                  {list
                    ? list.scan.complete
                      ? "Complete"
                      : "Partial · first 1,000"
                    : "Not scanned"}
                </strong>
              </div>
              <div>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void task(scan)}
                >
                  {busy ? "Working…" : "Scan mailbox"}
                </button>
              </div>
            </section>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Your senders</h2>
                  <p>Review patterns, inspect messages, and keep the final say.</p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => setPending(await api<CleanupPreview[]>("pending")))
                  }
                >
                  Review pending approvals
                </button>
              </div>
              <form
                className="filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  void task(() => refresh(0));
                }}
              >
                <label>
                  Category
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">All categories</option>
                    {classifications.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Sort by
                  <select value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="MESSAGE_COUNT">Most messages</option>
                    <option value="LATEST">Most recent</option>
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={candidates}
                    onChange={(e) => setCandidates(e.target.checked)}
                  />
                  Candidates only
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={ignored}
                    onChange={(e) => setIgnored(e.target.checked)}
                  />
                  Include ignored
                </label>
                <button type="submit" disabled={busy || !list}>
                  Apply filters
                </button>
              </form>
              {!list ? (
                <div className="empty">
                  <span className="empty-icon">↗</span>
                  <h3>Meet your mailbox, sender by sender.</h3>
                  <p>Scan up to 1,000 messages to see a clear overview. Nothing is moved.</p>
                </div>
              ) : list.items.length === 0 ? (
                <div className="empty">
                  <h3>
                    {list.scan.scannedMessages === 0
                      ? "Your mailbox is empty."
                      : "No senders match these filters."}
                  </h3>
                  <p>Try a different category or include ignored senders.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Sender</th>
                        <th>Classification</th>
                        <th>Messages</th>
                        <th>Unread</th>
                        <th>Latest</th>
                        <th>Detect as unwanted</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((g) => (
                        <SenderRow
                          key={g.sender.email}
                          group={g}
                          expanded={expanded === g.sender.email}
                          busy={busy}
                          expand={() =>
                            setExpanded(expanded === g.sender.email ? undefined : g.sender.email)
                          }
                          toggle={() =>
                            void task(async () => {
                              await api("tools/sender_set_detection", {
                                sender: g.sender.email,
                                detectionEnabled: !g.detectionEnabled,
                              });
                              await refresh();
                            })
                          }
                          review={() => void review(g.sender.email)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list && (
                <div className="pagination">
                  <span>
                    {list.total === 0 ? 0 : offset + 1}–{Math.min(offset + 20, list.total)} of{" "}
                    {list.total} senders · {new Date(list.scan.generatedAt).toLocaleTimeString()}
                  </span>
                  <div>
                    <button
                      type="button"
                      disabled={busy || offset === 0}
                      onClick={() => void task(() => refresh(Math.max(0, offset - 20)))}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={busy || offset + 20 >= list.total}
                      onClick={() => void task(() => refresh(offset + 20))}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </section>
            {pending.length > 0 && (
              <section className="panel pending">
                <h2>Pending operations</h2>
                {pending.map((p) => (
                  <div className="pending-item" key={p.id}>
                    <span>
                      {p.sender} · {p.messageCount} messages · {p.status}
                    </span>
                    {["EXECUTING", "UNCERTAIN"].includes(p.status) ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void task(async () => {
                            const r = await api<CleanupResult>("reconcile", { previewId: p.id });
                            setNotice(
                              `${r.moved} moved; ${r.uncertain} uncertain; ${r.remaining} not attempted. Reconciliation never moves messages.`,
                            );
                          })
                        }
                      >
                        Check outcomes
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setApprovedToken("");
                          setPreview(p);
                        }}
                      >
                        Review
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="feedback error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="feedback success">
            {notice}
          </div>
        )}
        <footer>Metadata only. No AI classification. No permanent deletion.</footer>
      </main>
      {preview && (
        <div className="overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            className="modal"
          >
            <span className="eyebrow">REVIEW BEFORE YOU ACT</span>
            <h2 id="preview-title">Move messages to Trash?</h2>
            <p className="sender-name">{preview.sender}</p>
            <div className="preview-stats">
              <div>
                <strong>{preview.messageCount}</strong>
                <span>Messages</span>
              </div>
              <div>
                <strong>{preview.unreadCount}</strong>
                <span>Unread</span>
              </div>
            </div>
            <p>
              {date(preview.oldestMessageAt)} — {date(preview.latestMessageAt)}
            </p>
            <p>
              The exact {preview.messageCount} messages in this preview will move to{" "}
              {account?.provider === "gmail" ? "Gmail" : "demo"} Trash. New arrivals are excluded.
              Provider retention rules may later purge trashed messages.
            </p>
            <p className="muted">
              Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}. Approval lasts at
              most two minutes.
            </p>
            {approvedToken ? (
              <div className="token">
                <label htmlFor="approval">Approved token for your MCP client</label>
                <textarea
                  id="approval"
                  readOnly
                  value={JSON.stringify({
                    previewId: preview.id,
                    confirmationToken: approvedToken,
                  })}
                />
                <p>
                  This approval can execute once. Share it only with the client you intend to run
                  the cleanup.
                </p>
              </div>
            ) : preview.status === "CONFIRMED" ? (
              <p>
                An approval already exists. Cancel and create a new preview if its token is
                unavailable.
              </p>
            ) : null}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => void cancel()}>
                Cancel cleanup
              </button>
              {preview.status === "PENDING" && (
                <>
                  <button type="button" disabled={busy} onClick={() => void confirm(false)}>
                    Approve for MCP
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void confirm(true)}
                  >
                    Move {preview.messageCount} messages to Trash
                  </button>
                </>
              )}
            </div>
            {approvedToken && (
              <button
                type="button"
                onClick={() => {
                  setPreview(undefined);
                  setApprovedToken("");
                }}
              >
                Close approved preview
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}
function SenderRow({
  group: g,
  expanded,
  busy,
  expand,
  toggle,
  review,
}: {
  group: SenderGroup;
  expanded: boolean;
  busy: boolean;
  expand: () => void;
  toggle: () => void;
  review: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button type="button" className="sender-button" onClick={expand} aria-expanded={expanded}>
            <span className="avatar">
              {(g.sender.displayName || g.sender.email).slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{g.sender.displayName || g.sender.email}</strong>
              <small>{g.sender.email}</small>
            </span>
            <span className="chevron">{expanded ? "−" : "+"}</span>
          </button>
        </td>
        <td>
          <span
            className={`badge ${g.classification.classification.toLowerCase()}`}
            title={g.classification.reasons.join("; ")}
          >
            {g.classification.classification.replace("_", " ")}
          </span>
          <small className="confidence">
            {Math.round(g.classification.confidence * 100)}% confidence
          </small>
        </td>
        <td className="number">{g.messageCount}</td>
        <td>{g.unreadCount}</td>
        <td className="nowrap">{date(g.latestMessageAt)}</td>
        <td>
          <button
            type="button"
            role="switch"
            aria-checked={g.detectionEnabled}
            aria-label={`Detect ${g.sender.email} as unwanted`}
            className={`toggle ${g.detectionEnabled ? "on" : ""}`}
            disabled={busy}
            onClick={toggle}
          >
            {g.detectionEnabled ? "On" : "Off"}
          </button>
        </td>
        <td>
          <button type="button" disabled={busy} onClick={review}>
            Review
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            <SenderDetails sender={g.sender.email} />
            <p className="reasons">{g.classification.reasons.join(" · ")}</p>
          </td>
        </tr>
      )}
    </>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
