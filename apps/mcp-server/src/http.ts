import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, resolve, sep } from "node:path";
import { z } from "zod";
import type { CleanupService } from "../../../packages/core/src/cleanup.js";
import { AppError, safeError } from "../../../packages/core/src/errors.js";
import type { MailboxService } from "../../../packages/core/src/mailbox.js";
import { toolsFor } from "./contracts.js";

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 16384) throw new AppError("VALIDATION_ERROR");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }
}
function authorized(req: IncomingMessage, key: string) {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
const previewInput = z.object({ previewId: z.string().uuid() }).strict();
export function createDashboardServer(
  mailbox: MailboxService,
  cleanup: CleanupService,
  key: string,
  assets: string,
) {
  const call = toolsFor(mailbox, cleanup);
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const address = req.socket.localPort;
    const host = `127.0.0.1:${address}`;
    const origin = `http://${host}`;
    try {
      if (req.headers.host !== host) throw new AppError("PERMISSION_DENIED");
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AppError("PERMISSION_DENIED");
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req, key)) throw new AppError("PERMISSION_DENIED");
        if (
          req.method !== "POST" ||
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json"
        )
          throw new AppError("PERMISSION_DENIED");
        const raw = await body(req);
        let result: unknown;
        if (url.pathname === "/api/session") {
          result = { account: mailbox.account };
        } else if (url.pathname === "/api/pending") {
          result = cleanup.pending();
        } else if (url.pathname === "/api/confirm" || url.pathname === "/api/reconcile") {
          const p = previewInput.safeParse(raw);
          if (!p.success) throw new AppError("VALIDATION_ERROR");
          result = url.pathname.endsWith("confirm")
            ? cleanup.confirmFromHuman(p.data.previewId)
            : await cleanup.reconcile(p.data.previewId);
        } else if (url.pathname.startsWith("/api/tools/")) {
          result = await call(url.pathname.slice(11), raw);
        } else throw new AppError("NOT_FOUND");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method !== "GET") throw new AppError("NOT_FOUND");
      const relative =
        url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const path = resolve(assets, relative);
      if (!path.startsWith(resolve(assets) + sep)) throw new AppError("NOT_FOUND");
      const data = await readFile(path).catch(() => {
        throw new AppError("NOT_FOUND");
      });
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
          } as Record<string, string>
        )[extname(path)] ?? "application/octet-stream",
      );
      res.end(data);
    } catch (error) {
      const e = safeError(error);
      res.statusCode = e.code === "PERMISSION_DENIED" ? 403 : e.code === "NOT_FOUND" ? 404 : 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e }));
    }
  });
}
