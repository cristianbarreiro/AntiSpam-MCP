import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Classification,
  CleanupPreview,
  CleanupResult,
  MailAccount,
  MailboxNoiseReport,
  MessageClassification,
  SenderGroup,
} from "../../../packages/core/src/domain.js";
import { classifications } from "../../../packages/core/src/domain.js";
import "./style.css";

const copy = {
  title: "Menos ruido. Más control.",
  subtitle: "Entendé qué llega a tu correo y decidí qué mover a Papelera.",
  metadata: "Clasificación determinista basada solo en metadatos; nunca se leen cuerpos.",
} as const;
const categoryNames: Record<Classification | "MIXED", string> = {
  IMPORTANT: "Importante",
  TRANSACTIONAL: "Transaccional",
  NOTIFICATION: "Notificación",
  NEWSLETTER: "Boletín",
  PROMOTIONAL: "Promoción",
  SUSPECTED_SPAM: "Posible spam",
  SPAM: "Spam",
  UNKNOWN: "Sin clasificar",
  MIXED: "Mixto",
};
type Message = {
  id: string;
  subject: string;
  date: string;
  unread: boolean;
  classification: MessageClassification;
};
type Listing = {
  items: SenderGroup[];
  total: number;
  scan: { scannedMessages: number; complete: boolean; generatedAt: string; requestedLimit: number };
};
let controlKey = "";
async function api<T>(path: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${controlKey}` },
    body: JSON.stringify(input),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message ?? "La operación no pudo completarse.");
  return value as T;
}
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("es-UY", { dateStyle: "medium" }).format(new Date(value));

function SenderDetails({
  sender,
  selected,
  onSelection,
}: {
  sender: string;
  selected: Set<string>;
  onSelection: (ids: Set<string>) => void;
}) {
  const [items, setItems] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load(next?: string) {
    setLoading(true);
    setError("");
    try {
      const page = await api<{ items: Message[]; cursor?: string }>(
        "tools/sender_message_classifications",
        { sender, limit: 25, ...(next ? { cursor: next } : {}) },
      );
      setItems((old) => (next ? [...old, ...page.items] : page.items));
      setCursor(page.cursor);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelection(next);
  }
  return (
    <div className="messages">
      <h3>Mensajes observados</h3>
      <p className="muted">
        Los asuntos son datos no confiables. No se descargan cuerpos ni adjuntos.
      </p>
      {error && <p role="alert">{error}</p>}
      {items.map((message) => (
        <label className="message selectable" key={message.id}>
          <input
            type="checkbox"
            checked={selected.has(message.id)}
            disabled={message.classification.protections.length > 0}
            onChange={() => toggle(message.id)}
            aria-label={`Seleccionar mensaje ${message.id}`}
          />
          <span className={message.unread ? "unread" : ""}>{message.subject}</span>
          <span>
            {categoryNames[message.classification.classification]} · {formatDate(message.date)} ·{" "}
            {message.unread ? "No leído" : "Leído"}
            {message.classification.protections.length
              ? ` · Protegido: ${message.classification.protections.join(", ")}`
              : ""}
          </span>
        </label>
      ))}
      <p className="muted">
        Los mensajes protegidos no se seleccionan aquí. “Vista completa” permite revisarlos con una
        confirmación humana adicional.
      </p>
      {!loading && !items.length && !error && <p>No hay mensajes en esta página.</p>}
      {cursor && (
        <button type="button" disabled={loading} onClick={() => void load(cursor)}>
          Cargar más mensajes
        </button>
      )}
      {loading && <p role="status">Cargando metadatos…</p>}
    </div>
  );
}

function App() {
  const [account, setAccount] = useState<MailAccount>();
  const [key, setKey] = useState("");
  const [list, setList] = useState<Listing>();
  const [report, setReport] = useState<MailboxNoiseReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState("");
  const [ignored, setIgnored] = useState(false);
  const [candidates, setCandidates] = useState(false);
  const [sort, setSort] = useState("MESSAGE_COUNT");
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [preview, setPreview] = useState<CleanupPreview>();
  const [pending, setPending] = useState<CleanupPreview[]>([]);
  const [approvedToken, setApprovedToken] = useState("");
  const [selectedSenders, setSelectedSenders] = useState<Set<string>>(new Set());
  const [selectedMessages, setSelectedMessages] = useState<Record<string, Set<string>>>({});
  const estimatedSelected = useMemo(
    () =>
      [...selectedSenders].reduce((total, sender) => {
        const explicit = selectedMessages[sender];
        return (
          total +
          (explicit?.size ||
            list?.items.find((group) => group.sender.email === sender)?.messageCount ||
            0)
        );
      }, 0),
    [selectedSenders, selectedMessages, list],
  );
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh(next = offset) {
    const [listing, noise] = await Promise.all([
      api<Listing>("tools/sender_list", {
        includeIgnored: ignored,
        candidatesOnly: candidates,
        sortBy: sort,
        limit: 20,
        offset: next,
        activeWithinDays: windowDays,
        ...(category ? { classification: category } : {}),
      }),
      api<MailboxNoiseReport>("tools/mailbox_noise_report", { windowDays, limit: 100 }),
    ]);
    setList(listing);
    setReport(noise);
    setOffset(next);
  }
  async function scan() {
    await api("tools/mailbox_scan", { maxMessages: 1000 });
    await refresh(0);
    setExpanded(undefined);
    setSelectedSenders(new Set());
    setSelectedMessages({});
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    await task(async () => {
      controlKey = key;
      const session = await api<{ account: MailAccount }>("session");
      setAccount(session.account);
      setKey("");
    });
  }
  async function review(sender: string) {
    await task(async () => {
      const next = await api<CleanupPreview>("tools/sender_cleanup_preview", { sender });
      setApprovedToken("");
      setPreview(next);
    });
  }
  async function preparePlan() {
    await task(async () => {
      const selections = [...selectedSenders].map((sender) => {
        const explicit = selectedMessages[sender];
        return { sender, ...(explicit?.size ? { messageIds: [...explicit] } : {}) };
      });
      const next = await api<CleanupPreview>("tools/cleanup_plan_preview", { selections });
      setApprovedToken("");
      setPreview(next);
    });
  }
  async function confirmProtected() {
    if (!preview) return;
    await task(async () => {
      setPreview(await api<CleanupPreview>("confirm-protected", { previewId: preview.id }));
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
      const result = await api<CleanupResult>("tools/cleanup_plan_execute", {
        previewId: preview.id,
        confirmationToken: approval.token,
      });
      setPreview(undefined);
      setPending([]);
      setList(undefined);
      setReport(undefined);
      setExpanded(undefined);
      setSelectedSenders(new Set());
      setSelectedMessages({});
      setNotice(
        `${result.moved} movidos, ${result.alreadyTrashed} ya estaban en Papelera, ${result.failed} fallaron, ${result.uncertain} inciertos y ${result.remaining} pendientes. Escaneá de nuevo para actualizar la vista.`,
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
      setNotice("Limpieza cancelada. Los movimientos ya completados no se revierten.");
    });
  }
  function toggleSender(sender: string) {
    const next = new Set(selectedSenders);
    if (next.has(sender)) {
      next.delete(sender);
      setSelectedMessages((current) => {
        const copy = { ...current };
        delete copy[sender];
        return copy;
      });
    } else next.add(sender);
    setSelectedSenders(next);
  }
  function selectMessages(sender: string, ids: Set<string>) {
    const nextSenders = new Set(selectedSenders);
    if (ids.size) nextSenders.add(sender);
    else nextSenders.delete(sender);
    setSelectedSenders(nextSenders);
    setSelectedMessages((current) => ({ ...current, [sender]: ids }));
  }

  return (
    <>
      <header>
        <a className="brand" href="/">
          <span className="mark">IG</span>InboxGuardian
        </a>
        <div className="header-meta">
          <span className="dot" />
          {account ? `${account.provider.toUpperCase()} · ${account.email}` : "ESPACIO LOCAL"}
        </div>
      </header>
      <main>
        <div className="eyebrow">INTELIGENCIA LOCAL SOBRE RUIDO</div>
        <div className="hero">
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
          <span className="safety-tag">Vista previa · Vos aprobás</span>
        </div>
        {!account ? (
          <section className="login panel">
            <h2>Abrí tu espacio local</h2>
            <p>
              Pegá la clave privada guardada en <code>.data/dashboard-key.local</code>.
            </p>
            <form onSubmit={login}>
              <label htmlFor="key">
                Clave local
                <input
                  id="key"
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Conectando…" : "Abrir"}
              </button>
            </form>
          </section>
        ) : (
          <>
            {account.provider === "mock" && (
              <div className="demo-banner">
                <strong>Buzón de demostración</strong>
                <span>Solo contiene mensajes sintéticos.</span>
              </div>
            )}
            <section className="stats" aria-label="Resumen del análisis">
              <div>
                <span>Mensajes observados</span>
                <strong>{report?.totalScanned ?? "—"}</strong>
              </div>
              <div>
                <span>En los últimos {windowDays} días</span>
                <strong>{report?.totalInWindow ?? "—"}</strong>
              </div>
              <div>
                <span>Cobertura</span>
                <strong className="small-stat">
                  {report ? (report.complete ? "Completa" : "Parcial") : "Sin escanear"}
                </strong>
              </div>
              <div>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void task(scan)}
                >
                  {busy ? "Procesando…" : "Escanear buzón"}
                </button>
              </div>
            </section>
            {report && (
              <p className={`coverage ${report.complete ? "" : "warning"}`}>
                {report.coverage} Muestreo: {new Date(report.sampledAt).toLocaleString("es-UY")}.
              </p>
            )}
            <p className="metadata-note">{copy.metadata}</p>
            {selectedSenders.size > 0 && (
              <section className="selection-bar" aria-live="polite">
                <span>
                  <strong>{selectedSenders.size}</strong> remitentes · hasta{" "}
                  <strong>{estimatedSelected}</strong> mensajes antes de aplicar protecciones
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void preparePlan()}
                >
                  Preparar plan único
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelectedSenders(new Set());
                    setSelectedMessages({});
                  }}
                >
                  Limpiar selección
                </button>
              </section>
            )}
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Remitentes observados</h2>
                  <p>Ordená, filtrá, inspeccioná y seleccioná sin modificar el buzón.</p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => setPending(await api<CleanupPreview[]>("pending")))
                  }
                >
                  Operaciones pendientes
                </button>
              </div>
              <form
                className="filters"
                onSubmit={(event) => {
                  event.preventDefault();
                  void task(() => refresh(0));
                }}
              >
                <label>
                  Categoría
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    <option value="">Todas</option>
                    {classifications.map((item) => (
                      <option key={item} value={item}>
                        {categoryNames[item]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Actividad
                  <select
                    value={windowDays}
                    onChange={(event) => setWindowDays(Number(event.target.value) as 7 | 30 | 90)}
                  >
                    <option value={7}>7 días</option>
                    <option value={30}>30 días</option>
                    <option value={90}>90 días</option>
                  </select>
                </label>
                <label>
                  Orden
                  <select value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="MESSAGE_COUNT">Mayor volumen</option>
                    <option value="LATEST">Más reciente</option>
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={candidates}
                    onChange={(event) => setCandidates(event.target.checked)}
                  />
                  Solo candidatos
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={ignored}
                    onChange={(event) => setIgnored(event.target.checked)}
                  />
                  Incluir ignorados
                </label>
                <button type="submit" disabled={busy || !list}>
                  Aplicar filtros
                </button>
              </form>
              {!list ? (
                <div className="empty">
                  <span className="empty-icon">↗</span>
                  <h3>Conocé tu buzón remitente por remitente.</h3>
                  <p>Escaneá una ventana de hasta 1.000 mensajes. Nada se mueve.</p>
                </div>
              ) : list.items.length === 0 ? (
                <div className="empty">
                  <h3>
                    {list.scan.scannedMessages === 0
                      ? "No hay mensajes en la ventana."
                      : "Ningún remitente coincide con los filtros."}
                  </h3>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Elegir</th>
                        <th>Remitente</th>
                        <th>Categorías</th>
                        <th>Mensajes</th>
                        <th>No leídos</th>
                        <th>Último</th>
                        <th>Detección</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((group) => (
                        <SenderRows
                          key={group.sender.email}
                          group={group}
                          expanded={expanded === group.sender.email}
                          selected={selectedSenders.has(group.sender.email)}
                          selectedMessages={selectedMessages[group.sender.email] ?? new Set()}
                          busy={busy}
                          expand={() =>
                            setExpanded(
                              expanded === group.sender.email ? undefined : group.sender.email,
                            )
                          }
                          toggleSender={() => toggleSender(group.sender.email)}
                          selectMessages={(ids) => selectMessages(group.sender.email, ids)}
                          toggleDetection={() =>
                            void task(async () => {
                              await api("tools/sender_set_detection", {
                                sender: group.sender.email,
                                detectionEnabled: !group.detectionEnabled,
                              });
                              await refresh();
                            })
                          }
                          review={() => void review(group.sender.email)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list && (
                <div className="pagination">
                  <span>
                    {list.total === 0 ? 0 : offset + 1}–{Math.min(offset + 20, list.total)} de{" "}
                    {list.total} · {new Date(list.scan.generatedAt).toLocaleTimeString("es-UY")}
                  </span>
                  <div>
                    <button
                      type="button"
                      disabled={busy || offset === 0}
                      onClick={() => void task(() => refresh(Math.max(0, offset - 20)))}
                    >
                      Anterior
                    </button>
                    <button
                      type="button"
                      disabled={busy || offset + 20 >= list.total}
                      onClick={() => void task(() => refresh(offset + 20))}
                    >
                      Siguiente
                    </button>
                  </div>
                </div>
              )}
            </section>
            {pending.length > 0 && (
              <section className="panel pending">
                <h2>Operaciones pendientes</h2>
                {pending.map((item) => (
                  <div className="pending-item" key={item.id}>
                    <span>
                      {item.senders?.length ?? 1} remitente(s) · {item.messageCount} mensajes ·{" "}
                      {item.status}
                    </span>
                    {["EXECUTING", "UNCERTAIN"].includes(item.status) ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void task(async () => {
                            const result = await api<CleanupResult>("reconcile", {
                              previewId: item.id,
                            });
                            setNotice(
                              `${result.moved} movidos; ${result.uncertain} inciertos; ${result.remaining} pendientes.`,
                            );
                          })
                        }
                      >
                        Revisar resultados
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setApprovedToken("");
                          setPreview(item);
                        }}
                      >
                        Revisar
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
        <footer>Solo metadatos · Sin IA externa · Sin borrado permanente</footer>
      </main>
      {preview && (
        <PreviewDialog
          preview={preview}
          account={account}
          busy={busy}
          approvedToken={approvedToken}
          error={error}
          onCancel={() => void cancel()}
          onProtected={() => void confirmProtected()}
          onApprove={() => void confirm(false)}
          onExecute={() => void confirm(true)}
          onClose={() => {
            setPreview(undefined);
            setApprovedToken("");
          }}
        />
      )}
    </>
  );
}

function SenderRows({
  group,
  expanded,
  selected,
  selectedMessages,
  busy,
  expand,
  toggleSender,
  selectMessages,
  toggleDetection,
  review,
}: {
  group: SenderGroup;
  expanded: boolean;
  selected: boolean;
  selectedMessages: Set<string>;
  busy: boolean;
  expand: () => void;
  toggleSender: () => void;
  selectMessages: (ids: Set<string>) => void;
  toggleDetection: () => void;
  review: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <input
            type="checkbox"
            checked={selected}
            onChange={toggleSender}
            aria-label={`Seleccionar remitente ${group.sender.email}`}
          />
        </td>
        <td>
          <button type="button" className="sender-button" onClick={expand} aria-expanded={expanded}>
            <span className="avatar">
              {(group.sender.displayName || group.sender.email).slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{group.sender.displayName || group.sender.email}</strong>
              <small>{group.sender.email}</small>
            </span>
            <span className="chevron">{expanded ? "−" : "+"}</span>
          </button>
        </td>
        <td>
          <span
            className={`badge ${group.presentationClassification.toLowerCase()}`}
            title={group.classification.reasons.join("; ")}
          >
            {categoryNames[group.presentationClassification]}
          </span>
          <small className="confidence">
            {Object.entries(group.classificationBreakdown)
              .map(([name, count]) => `${categoryNames[name as Classification]} ${count}`)
              .join(" · ")}
          </small>
        </td>
        <td className="number">{group.messageCount}</td>
        <td>{group.unreadCount}</td>
        <td className="nowrap">{formatDate(group.latestMessageAt)}</td>
        <td>
          <button
            type="button"
            role="switch"
            aria-checked={group.detectionEnabled}
            aria-label={`Detectar ruido de ${group.sender.email}`}
            className={`toggle ${group.detectionEnabled ? "on" : ""}`}
            disabled={busy}
            onClick={toggleDetection}
          >
            {group.detectionEnabled ? "Sí" : "No"}
          </button>
        </td>
        <td>
          <button type="button" disabled={busy} onClick={review}>
            Vista completa
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8}>
            <SenderDetails
              sender={group.sender.email}
              selected={selectedMessages}
              onSelection={selectMessages}
            />
            <p className="reasons">{group.classification.reasons.join(" · ")}</p>
          </td>
        </tr>
      )}
    </>
  );
}

function PreviewDialog({
  preview,
  account,
  busy,
  approvedToken,
  error,
  onCancel,
  onProtected,
  onApprove,
  onExecute,
  onClose,
}: {
  preview: CleanupPreview;
  account?: MailAccount;
  busy: boolean;
  approvedToken: string;
  error: string;
  onCancel: () => void;
  onProtected: () => void;
  onApprove: () => void;
  onExecute: () => void;
  onClose: () => void;
}) {
  const protectedPending = preview.requiresProtectedConfirmation && !preview.protectedConfirmedAt;
  return (
    <div className="overlay">
      <section role="dialog" aria-modal="true" aria-labelledby="preview-title" className="modal">
        <span className="eyebrow">REVISÁ ANTES DE ACTUAR</span>
        <h2 id="preview-title">¿Mover este conjunto a Papelera?</h2>
        <p>{preview.senders?.length ?? 1} remitente(s) · IDs exactos e inmutables</p>
        <div className="preview-stats">
          <div>
            <strong>{preview.messageCount}</strong>
            <span>Mensajes</span>
          </div>
          <div>
            <strong>{preview.unreadCount}</strong>
            <span>No leídos</span>
          </div>
        </div>
        <p>
          {formatDate(preview.oldestMessageAt)} — {formatDate(preview.latestMessageAt)}
        </p>
        {preview.senders?.map((sender) => (
          <div className="preview-sender" key={sender.sender}>
            <strong>{sender.sender}</strong>
            <span>
              {sender.messageCount} mensajes ·{" "}
              {Object.entries(sender.classificationBreakdown)
                .map(([name, count]) => `${categoryNames[name as Classification]} ${count}`)
                .join(" · ")}
            </span>
          </div>
        ))}
        {preview.warnings?.map((warning) => (
          <p className="warning" key={warning}>
            {warning}
          </p>
        ))}
        <p>
          Solo estos {preview.messageCount} mensajes pasarán a la Papelera de{" "}
          {account?.provider === "gmail" ? "Gmail" : "demostración"}. Los mensajes nuevos quedan
          fuera.
        </p>
        <p className="muted">
          La vista vence a las {new Date(preview.expiresAt).toLocaleTimeString("es-UY")}; la
          aprobación dura como máximo dos minutos.
        </p>
        {approvedToken && (
          <div className="token">
            <label htmlFor="approval">
              Token aprobado para el cliente MCP
              <textarea
                id="approval"
                readOnly
                value={JSON.stringify({ previewId: preview.id, confirmationToken: approvedToken })}
              />
            </label>
            <p>Se puede ejecutar una sola vez.</p>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          {protectedPending ? (
            <button type="button" className="danger" disabled={busy} onClick={onProtected}>
              Confirmar inclusión de mensajes protegidos
            </button>
          ) : preview.status === "PENDING" ? (
            <>
              <button type="button" disabled={busy} onClick={onApprove}>
                Aprobar para MCP
              </button>
              <button type="button" className="danger" disabled={busy} onClick={onExecute}>
                Mover {preview.messageCount} a Papelera
              </button>
            </>
          ) : null}
        </div>
        {approvedToken && (
          <button type="button" onClick={onClose}>
            Cerrar vista aprobada
          </button>
        )}
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
