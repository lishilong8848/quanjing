import { createHash } from 'node:crypto';
import FormData = require('form-data');
import type { LifecycleReceiptImageGateway } from './purchase-lifecycle-receipt-image-coordinator';
import type { PurchaseLifecycleReceiptEventTransport } from './purchase-lifecycle-receipt-event-verifier';
import type { LifecyclePrivateChatTransport } from './purchase-lifecycle-private-chat-verifier';

type Config = { appId: string; appSecret: string; appToken: string };
type Response = { data: any; headers?: Record<string, unknown> };
type Http = { get(url: string, config: Record<string, unknown>): Promise<Response>; post(url: string, body: unknown, config: Record<string, unknown>): Promise<Response> };
type TrustedWsOrigin = (payload: unknown, expectedAppId: string) => boolean;
const API = 'https://open.feishu.cn/open-apis';
const MAX_BYTES = 20 * 1024 * 1024;
const fail = (): never => { throw new Error('采购签收图片飞书来源不可核对'); };
function obj(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function identifier(value: unknown, prefix: 'om_' | 'oc_' | ''): value is string {
  return typeof value === 'string' && value.length <= 256 && (prefix ? value.startsWith(prefix) : true) && /^[A-Za-z0-9_:-]+$/.test(value);
}
function mimeOf(buffer: Buffer): { mime: string; extension: string } | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime:'image/jpeg', extension:'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime:'image/png', extension:'png' };
  if (buffer.length >= 6 && ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'))) return { mime:'image/gif', extension:'gif' };
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return { mime:'image/webp', extension:'webp' };
  return undefined;
}
function digest(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }
function frozenTree(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 20 || seen.has(value) || !Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every(child => frozenTree(child, seen, depth + 1));
}

/** Isolated adapter. Origin must be attested by the authenticated WS dispatcher,
 * never by request fields. A store fence is required before invoking upload. */
export function createLifecycleReceiptFeishuTransport(options: { readConfig: () => Config; http: Http; isAuthenticatedWsDelivery?: TrustedWsOrigin }): PurchaseLifecycleReceiptEventTransport & LifecyclePrivateChatTransport & LifecycleReceiptImageGateway {
  const downloaded = new WeakMap<Buffer, { hash: string; config: Config; mime: string; extension: string; consumed: boolean }>();
  const current = (): Config => {
    const value = options?.readConfig?.();
    if (!value || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || typeof value.appSecret !== 'string' || !value.appSecret || !/^[A-Za-z0-9_-]{1,160}$/.test(value.appToken)) return fail();
    return { appId:value.appId, appSecret:value.appSecret, appToken:value.appToken };
  };
  const unchanged = (bound: Config) => { const now=current(); if (now.appId!==bound.appId || now.appSecret!==bound.appSecret || now.appToken!==bound.appToken) fail(); };
  const token = async (bound: Config): Promise<string> => {
    unchanged(bound);
    const response = await options.http.post(`${API}/auth/v3/tenant_access_token/internal`, { app_id:bound.appId, app_secret:bound.appSecret }, { timeout:10000, maxRedirects:0 }).catch(() => fail());
    unchanged(bound);
    if (response.data?.code !== 0 || typeof response.data.tenant_access_token !== 'string' || !response.data.tenant_access_token) return fail();
    return response.data.tenant_access_token;
  };
  const get = async (bound: Config, url: string, params: Record<string,unknown> = {}) => {
    const credential=await token(bound); unchanged(bound);
    const response=await options.http.get(url, { headers:{ Authorization:`Bearer ${credential}` }, params, timeout:10000, maxRedirects:0 }).catch(() => fail());
    unchanged(bound); if (response.data?.code !== 0 || !obj(response.data.data)) return fail(); return response.data;
  };
  return {
    currentAppId() { return current().appId; },
    async verifyEventOrigin(payload, expectedAppId) {
      const bound=current();
      // The real dispatcher must pass an immutable copy and prove it was emitted
      // by its authenticated connection. Shape or a claimed app ID is not proof.
      if (bound.appId!==expectedAppId || !options.isAuthenticatedWsDelivery || !frozenTree(payload) || options.isAuthenticatedWsDelivery(payload,expectedAppId)!==true) return false;
      unchanged(bound); return true;
    },
    async readImageMessage(messageId, expectedAppId) {
      if (!identifier(messageId,'om_')) return fail(); const bound=current(); if (bound.appId!==expectedAppId) return fail();
      const envelope=await get(bound,`${API}/im/v1/messages/${encodeURIComponent(messageId)}`,{user_id_type:'open_id'});
      const items=envelope.data.items;
      if (!Array.isArray(items) || items.length!==1) return fail();
      const message=obj(items[0]), sender=obj(message?.sender), body=obj(message?.body);
      if (!message || message.message_id!==messageId || !identifier(message.chat_id,'oc_') || message.msg_type!=='image' || message.deleted!==false || sender?.sender_type!=='user' || sender.id_type!=='open_id' || !identifier(sender.id,'') || !String(sender.id).startsWith('ou_') || typeof body?.content!=='string' || body.content.length>4096) return fail();
      let content: unknown; try { content=JSON.parse(body.content); } catch { return fail(); }
      const imageKey=obj(content)?.image_key, time=Number(message.create_time);
      if (!identifier(imageKey,'') || !Number.isSafeInteger(time) || time<1_000_000_000_000) return fail();
      return { messageId, chatId:message.chat_id, senderOpenId:sender.id, messageType:'image', imageKey, createdAtMs:time, deleted:false };
    },
    async readCard(appId,messageId) { if (!identifier(messageId,'om_')) return fail(); const bound=current(); if(bound.appId!==appId)return fail(); return get(bound,`${API}/im/v1/messages/${encodeURIComponent(messageId)}`,{user_id_type:'open_id'}); },
    async readChat(appId,chatId) { if (!identifier(chatId,'oc_')) return fail(); const bound=current(); if(bound.appId!==appId)return fail(); return get(bound,`${API}/im/v1/chats/${encodeURIComponent(chatId)}`); },
    async readMembers(appId,chatId,pageToken) { if (!identifier(chatId,'oc_') || pageToken !== undefined && !identifier(pageToken,'')) return fail(); const bound=current(); if(bound.appId!==appId)return fail(); return get(bound,`${API}/im/v1/chats/${encodeURIComponent(chatId)}/members`,{member_id_type:'open_id',page_size:100,...(pageToken?{page_token:pageToken}:{})}); },
    async downloadMessageImage(messageId,imageKey) {
      if (!identifier(messageId,'om_') || !identifier(imageKey,'')) return fail();
      const bound=current(), credential=await token(bound); unchanged(bound);
      const response=await options.http.get(`${API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}`,{headers:{Authorization:`Bearer ${credential}`},params:{type:'image'},responseType:'arraybuffer',timeout:60000,maxRedirects:0,maxContentLength:MAX_BYTES}).catch(() => fail());
      unchanged(bound);
      if (!Buffer.isBuffer(response.data) && !(response.data instanceof ArrayBuffer)) return fail();
      const buffer=Buffer.isBuffer(response.data) ? Buffer.from(response.data) : Buffer.from(response.data as ArrayBuffer);
      const type=mimeOf(buffer), declared=String(response.headers?.['content-type'] || '').split(';')[0].toLowerCase();
      if (!buffer.length || buffer.length>MAX_BYTES || !type || declared!==type.mime) return fail();
      downloaded.set(buffer,{hash:digest(buffer),config:bound,...type,consumed:false}); return buffer;
    },
    async uploadAttachment(content) {
      const state=Buffer.isBuffer(content) ? downloaded.get(content) : undefined;
      if (!state || state.consumed || digest(content)!==state.hash) return fail();
      // Never retry this buffer even if a timeout makes the remote result unknown.
      state.consumed=true; unchanged(state.config);
      const credential=await token(state.config); unchanged(state.config); if(digest(content)!==state.hash)return fail();
      const form=new FormData(); form.append('file_name',`receipt.${state.extension}`); form.append('parent_type','bitable_file'); form.append('parent_node',state.config.appToken); form.append('size',String(content.length)); form.append('file',content,{filename:`receipt.${state.extension}`,contentType:state.mime});
      const response=await options.http.post(`${API}/drive/v1/medias/upload_all`,form,{headers:{Authorization:`Bearer ${credential}`,...form.getHeaders()},timeout:60000,maxRedirects:0,maxBodyLength:MAX_BYTES + 1024*1024}).catch(() => fail());
      const fileToken=response.data?.data?.file_token;
      // The request was already sent to the frozen Base. Preserve its confirmed
      // receipt even if configuration changes while awaiting the response;
      // attaching that receipt is separately fenced by the current store/runtime.
      if(response.data?.code!==0 || typeof fileToken!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(fileToken))return fail();
      return fileToken;
    },
  };
}
