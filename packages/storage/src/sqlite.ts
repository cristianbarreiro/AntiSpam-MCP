import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent, CleanupPreview, Outcome, PreviewStatus, SenderPolicy } from "../../core/src/domain.js";
import { AppError } from "../../core/src/errors.js";
import type { Store } from "../../core/src/store.js";
const migration1 = `
CREATE TABLE sender_policies(account TEXT NOT NULL, sender TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated TEXT NOT NULL, PRIMARY KEY(account,sender)) STRICT;
CREATE TABLE cleanup_previews(id TEXT PRIMARY KEY, account TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, token_hash TEXT, token_expiry TEXT, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX previews_account ON cleanup_previews(account,status);
CREATE TABLE cleanup_outcomes(preview_id TEXT NOT NULL REFERENCES cleanup_previews(id) ON DELETE CASCADE, message_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(preview_id,message_id)) STRICT;
CREATE TABLE audit_events(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL, account TEXT NOT NULL, preview_id TEXT, count INTEGER, result TEXT) STRICT;
CREATE INDEX audit_account ON audit_events(account,id);
`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(path, {timeout:5000});
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  }
  migrate() {
    this.transaction(() => {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 1) throw new AppError("INTERNAL_ERROR");
      if (version === 0) { this.db.exec(migration1); this.db.exec("PRAGMA user_version=1"); }
    });
  }
  close() { this.db.close(); }
  private transaction<T>(fn:()=>T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result=fn(); this.db.exec("COMMIT"); return result; }
    catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
  policy(account:string,sender:string): SenderPolicy | undefined {
    const row=this.db.prepare("SELECT * FROM sender_policies WHERE account=? AND sender=?").get(account,sender);
    return row ? {accountId:account,sender,detectionEnabled:row.enabled === 1,updatedAt:String(row.updated),source:"USER"} : undefined;
  }
  setPolicy(p:SenderPolicy) {
    this.transaction(() => {
      this.db.prepare("INSERT INTO sender_policies VALUES(?,?,?,?) ON CONFLICT(account,sender) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated").run(p.accountId,p.sender,Number(p.detectionEnabled),p.updatedAt);
      this.audit(p.accountId,"SENDER_POLICY_CHANGED",{result:p.detectionEnabled?"DETECT":"IGNORE"});
    });
  }
  savePreview(p:CleanupPreview) {
    this.transaction(() => {
      this.db.prepare("INSERT INTO cleanup_previews(id,account,data,status) VALUES(?,?,?,?)").run(p.id,p.accountId,JSON.stringify(p),p.status);
      this.audit(p.accountId,"CLEANUP_PREVIEW_CREATED",{previewId:p.id,count:p.messageCount});
    });
  }
  private row(account:string,id:string): Row {
    const row=this.db.prepare("SELECT * FROM cleanup_previews WHERE account=? AND id=?").get(account,id);
    if (!row) throw new AppError("NOT_FOUND"); return row;
  }
  preview(account:string,id:string): CleanupPreview {
    const row=this.row(account,id);
    return {...JSON.parse(String(row.data)) as CleanupPreview,status:row.status as PreviewStatus};
  }
  pending(account:string): CleanupPreview[] {
    return this.db.prepare("SELECT id FROM cleanup_previews WHERE account=? AND status IN ('PENDING','CONFIRMED','EXECUTING','UNCERTAIN') ORDER BY rowid DESC LIMIT 30").all(account).map(r=>this.preview(account,String(r.id)));
  }
  confirm(account:string,id:string,hash:string,expiry:string,now:string) {
    this.transaction(()=>{
      const p=this.preview(account,id);
      if (p.expiresAt<=now) throw new AppError("CONFIRMATION_EXPIRED");
      if (p.status === "CANCELLED") throw new AppError("CANCELLED");
      if (p.status !== "PENDING") throw new AppError("CONFIRMATION_ALREADY_USED");
      this.db.prepare("UPDATE cleanup_previews SET status='CONFIRMED',token_hash=?,token_expiry=? WHERE account=? AND id=?").run(hash,expiry,account,id);
      this.audit(account,"CLEANUP_CONFIRMED",{previewId:id,count:p.messageCount});
    });
  }
  claim(account:string,id:string,hash:string,now:string):CleanupPreview {
    return this.transaction(()=>{
      const row=this.row(account,id); const p=this.preview(account,id);
      if(row.cancelled===1) throw new AppError("CANCELLED");
      if(row.consumed===1) throw new AppError("CONFIRMATION_ALREADY_USED");
      if(!row.token_hash || row.token_hash!==hash) throw new AppError("CONFIRMATION_REQUIRED");
      if(String(row.token_expiry)<=now || p.expiresAt<=now) throw new AppError("CONFIRMATION_EXPIRED");
      if(p.status!=="CONFIRMED") throw new AppError("CONFIRMATION_REQUIRED");
      this.db.prepare("UPDATE cleanup_previews SET consumed=1,status='EXECUTING' WHERE account=? AND id=?").run(account,id);
      this.audit(account,"CLEANUP_STARTED",{previewId:id,count:p.messageCount});
      return p;
    });
  }
  cancelled(account:string,id:string) { return this.row(account,id).cancelled===1; }
  cancel(account:string,id:string) {
    this.transaction(()=>{
      const p=this.preview(account,id);
      if(["COMPLETED","PARTIAL"].includes(p.status)) throw new AppError("CONFIRMATION_ALREADY_USED");
      this.db.prepare("UPDATE cleanup_previews SET cancelled=1,status=CASE WHEN status='EXECUTING' THEN status ELSE 'CANCELLED' END,token_hash=NULL WHERE account=? AND id=?").run(account,id);
      this.audit(account,"CLEANUP_CANCELLED",{previewId:id});
    });
  }
  recordOutcome(account:string,id:string,messageId:string,outcome:Outcome) {
    const p=this.preview(account,id);
    if(!p.messageIds.includes(messageId)) throw new AppError("PERMISSION_DENIED");
    this.db.prepare("INSERT INTO cleanup_outcomes VALUES(?,?,?) ON CONFLICT(preview_id,message_id) DO UPDATE SET outcome=excluded.outcome").run(id,messageId,outcome);
  }
  outcomes(account:string,id:string):Record<string,Outcome> {
    this.row(account,id);
    return Object.fromEntries(this.db.prepare("SELECT message_id,outcome FROM cleanup_outcomes WHERE preview_id=?").all(id).map(r=>[String(r.message_id),r.outcome as Outcome]));
  }
  finish(account:string,id:string,status:PreviewStatus) {
    this.transaction(()=>{
      this.row(account,id);
      this.db.prepare("UPDATE cleanup_previews SET status=? WHERE account=? AND id=?").run(status,account,id);
      const moved=Object.values(this.outcomes(account,id)).filter(x=>x==="MOVED").length;
      this.audit(account,status==="COMPLETED"?"CLEANUP_EXECUTED":"CLEANUP_FAILED",{previewId:id,count:moved,result:status});
    });
  }
  audit(account:string,action:string,d:{previewId?:string;count?:number;result?:string}={}) {
    this.db.prepare("INSERT INTO audit_events(timestamp,action,account,preview_id,count,result) VALUES(?,?,?,?,?,?)").run(new Date().toISOString(),action,account,d.previewId??null,d.count??null,d.result??null);
  }
  audits(account:string,limit:number):AuditEvent[] {
    return this.db.prepare("SELECT * FROM audit_events WHERE account=? ORDER BY id DESC LIMIT ?").all(account,limit).map(r=>({id:Number(r.id),timestamp:String(r.timestamp),action:String(r.action),accountId:account,...(r.preview_id?{previewId:String(r.preview_id)}:{}),...(r.count!==null?{count:Number(r.count)}:{}),...(r.result?{result:String(r.result)}:{})}));
  }
  prune(now=new Date()) {
    const cutoff=new Date(now.getTime()-30*86400000).toISOString();
    this.transaction(()=>{
      this.db.prepare("DELETE FROM cleanup_previews WHERE status NOT IN ('EXECUTING','UNCERTAIN') AND json_extract(data,'createdAt')<?").run(cutoff);
      this.db.prepare("DELETE FROM audit_events WHERE timestamp<? AND (preview_id IS NULL OR preview_id NOT IN (SELECT id FROM cleanup_previews WHERE status IN ('EXECUTING','UNCERTAIN')))").run(cutoff);
    });
  }
}
