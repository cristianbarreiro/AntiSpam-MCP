import { randomUUID } from "node:crypto";
import type { Classification, MailAccount, MailMessage, MailProvider, MailboxScanResult, SenderGroup } from "./domain.js";
import { aggregate } from "./aggregation.js";
import { AppError } from "./errors.js";
import { normalizeAddress } from "./sender.js";
import type { Store } from "./store.js";
export class MailboxService {
  private cache: {messages:MailMessage[]; summary:MailboxScanResult; expires:number} | undefined;
  private cursors=new Map<string,{sender:string;provider:string;expires:number}>();
  constructor(readonly provider:MailProvider,readonly store:Store,readonly account:MailAccount,private readonly now=()=>Date.now()) {}
  assertAccount(m:MailMessage) { if(m.accountId!==this.account.id) throw new AppError("PERMISSION_DENIED"); }
  async collect(max:number,sender?:string) {
    const messages=new Map<string,MailMessage>(); const seen=new Set<string>(); let cursor:string|undefined;
    for(let pages=0;pages<100;pages++) {
      const page=await this.provider.scanMessages({limit:Math.min(100,max-messages.size),...(cursor?{cursor}:{}),...(sender?{sender}:{})});
      for(const m of page.items) { this.assertAccount(m); if(!m.trashed && (!sender||m.sender.email===sender)) messages.set(m.id,m); }
      if(messages.size>max) throw new AppError("PROVIDER_ERROR");
      if(!page.cursor) return {messages:[...messages.values()],complete:true};
      if(messages.size>=max) return {messages:[...messages.values()],complete:false};
      if(seen.has(page.cursor)) throw new AppError("PROVIDER_ERROR"); seen.add(page.cursor); cursor=page.cursor;
    }
    return {messages:[...messages.values()],complete:false};
  }
  private groups(messages:MailMessage[]) { return aggregate(messages,(a,s)=>this.store.policy(a,s)?.detectionEnabled??true); }
  async scan(maxMessages:number):Promise<MailboxScanResult> {
    const {messages,complete}=await this.collect(maxMessages);
    const groups=this.groups(messages); const classificationSummary:MailboxScanResult["classificationSummary"]={};
    for(const g of groups) classificationSummary[g.classification.classification]=(classificationSummary[g.classification.classification]??0)+1;
    const summary={scannedMessages:messages.length,senderCount:groups.length,complete,generatedAt:new Date(this.now()).toISOString(),classificationSummary};
    this.store.audit(this.account.id,"SCAN_COMPLETED",{count:messages.length,result:complete?"COMPLETE":"PARTIAL"});
    this.cache={messages,summary,expires:this.now()+300000}; return summary;
  }
  list(input:{classification?:Classification;minimumMessages:number;includeIgnored:boolean;sortBy:"MESSAGE_COUNT"|"LATEST";limit:number;offset:number;candidatesOnly:boolean}) {
    if(!this.cache || this.cache.expires<this.now()) throw new AppError("SCAN_REQUIRED");
    let groups=this.groups(this.cache.messages).filter(g=>(input.includeIgnored||g.detectionEnabled)&&(!input.classification||g.classification.classification===input.classification)&&g.messageCount>=input.minimumMessages&&(!input.candidatesOnly||g.candidate));
    groups=groups.sort((a,b)=>(input.sortBy==="LATEST"?b.latestMessageAt.localeCompare(a.latestMessageAt):b.messageCount-a.messageCount)||a.sender.email.localeCompare(b.sender.email));
    return {items:groups.slice(input.offset,input.offset+input.limit),total:groups.length,scan:this.cache.summary};
  }
  async messages(senderInput:string,limit:number,cursor?:string) {
    const sender=normalizeAddress(senderInput); let providerCursor:string|undefined;
    if(cursor) { const c=this.cursors.get(cursor); if(!c||c.sender!==sender||c.expires<this.now()) throw new AppError("VALIDATION_ERROR"); providerCursor=c.provider; }
    const page=await this.provider.scanMessages({sender,limit,...(providerCursor?{cursor:providerCursor}:{})});
    for(const m of page.items) this.assertAccount(m);
    let next:string|undefined;
    if(page.cursor) {
      for(const [id,c] of this.cursors) if(c.expires<this.now()) this.cursors.delete(id);
      if(this.cursors.size>=500) this.cursors.delete(this.cursors.keys().next().value ?? "");
      next=randomUUID(); this.cursors.set(next,{sender,provider:page.cursor,expires:this.now()+300000});
    }
    return {items:page.items.filter(m=>!m.trashed&&m.sender.email===sender).map(m=>({id:m.id,subject:m.subject,date:m.date,unread:m.unread})),...(next?{cursor:next}:{})};
  }
  setDetection(senderInput:string,detectionEnabled:boolean) {
    const p={sender:normalizeAddress(senderInput),accountId:this.account.id,detectionEnabled,updatedAt:new Date(this.now()).toISOString(),source:"USER" as const};
    this.store.setPolicy(p); return p;
  }
  invalidate() { this.cache=undefined; }
  group(messages:MailMessage[]):SenderGroup|undefined { return this.groups(messages)[0]; }
}
