import * as Lark from '@larksuiteoapi/node-sdk';

type Credentials = { appId: string; appSecret: string };
type CardHandler = (payload: unknown) => Promise<unknown>;
type MessageHandler = (payload: Readonly<Record<string, unknown>>) => Promise<void>;
type Client = { start(input: { eventDispatcher: unknown }): Promise<unknown>; close(input: { force: boolean }): void; getConnectionStatus(): { state?: string } };
type SdkPort = {
  createDispatcher(card: CardHandler, message: (payload: unknown) => Promise<void>): unknown;
  createClient(options: { appId: string; appSecret: string; onReady: () => void; onError: (error: unknown) => void; onReconnecting: () => void; onReconnected: () => void }): Client;
};
const productionSdk: SdkPort = {
  createDispatcher(card, message) {
    return new Lark.EventDispatcher({ loggerLevel:Lark.LoggerLevel.error }).register({
      'card.action.trigger': card as never,
      'im.message.receive_v1': message as never,
    });
  },
  createClient(options) {
    return new Lark.WSClient({ ...options, autoReconnect:true, handshakeTimeoutMs:10_000, wsConfig:{pingTimeout:10}, loggerLevel:Lark.LoggerLevel.error }) as unknown as Client;
  },
};
function copyFrozen(raw: unknown): Readonly<Record<string, unknown>> {
  let serialized: string;
  try { serialized=JSON.stringify(raw); } catch { throw new Error('飞书事件不可核对'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized,'utf8') > 64 * 1024) throw new Error('飞书事件不可核对');
  const copy: unknown=JSON.parse(serialized);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('飞书事件不可核对');
  let count=0;
  const freeze = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object') return;
    if (++count > 4096 || depth > 20) throw new Error('飞书事件不可核对');
    for (const child of Object.values(value)) freeze(child,depth+1);
    Object.freeze(value);
  };
  freeze(copy,0); return copy as Readonly<Record<string,unknown>>;
}

/** Unregistered adapter. Replace the existing SDK transport when integrating;
 * do not start a second connection. The dispatcher and proof issuer never escape. */
export function createLifecycleReceiptWsIngress(options: {
  readCredentials: () => Credentials;
  onCard: CardHandler;
  onMessage: MessageHandler;
  onFailure: () => void;
  /** For isolated tests only. Production must omit this and use the real SDK. */
  sdkForTests?: SdkPort;
}) {
  const proofs=new WeakMap<object,string>();
  const sdk=options.sdkForTests || productionSdk;
  let client:Client | undefined, bound:Credentials | undefined, ready=false, closing=false, generation=0;
  let cancelStart:(()=>void) | undefined;
  const config = (): Credentials => {
    const value=options.readCredentials();
    if (!value || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || typeof value.appSecret !== 'string' || !value.appSecret) throw new Error('飞书连接身份不可核对');
    return {appId:value.appId,appSecret:value.appSecret};
  };
  const active = (): boolean => {
    if (!ready || closing || !client || !bound) return false;
    try { const now=config(); return now.appId===bound.appId && now.appSecret===bound.appSecret && client.getConnectionStatus().state==='connected'; } catch { return false; }
  };
  return {
    isReady(): boolean { return active(); },
    isAuthenticatedWsDelivery(payload: unknown, expectedAppId: string): boolean {
      return !!payload && typeof payload==='object' && active() && bound?.appId===expectedAppId && proofs.get(payload)===expectedAppId;
    },
    async start(): Promise<void> {
      if (client || closing || typeof options.onCard!=='function' || typeof options.onMessage!=='function' || typeof options.onFailure!=='function') throw new Error('飞书连接尚未就绪');
      bound=config(); const app=bound, epoch=++generation;
      const dispatcher=sdk.createDispatcher(async payload => {
        if (!active() || bound!==app) throw new Error('飞书连接身份已变化，请稍后重试');
        return options.onCard(payload);
      }, async raw => {
        if (!active() || bound!==app) return;
        const payload=copyFrozen(raw);
        proofs.set(payload,app.appId);
        try { await options.onMessage(payload); } finally { proofs.delete(payload); }
      });
      await new Promise<void>((resolve,reject) => {
        let settled=false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish=(error?: Error) => { if (settled) return; settled=true; cancelStart=undefined; if(timer)clearTimeout(timer); if(error)reject(error);else resolve(); };
        const failure=() => { if(epoch!==generation || closing)return; generation++; ready=false; const failed=client;client=undefined;bound=undefined;failed?.close({force:true});if (!settled) finish(new Error('飞书连接不可用')); else options.onFailure(); };
        cancelStart=()=>finish(new Error('飞书连接已关闭'));
        timer=setTimeout(failure,15000);
        try {
          client=sdk.createClient({ ...app, onReady:()=>{if(epoch===generation && !closing){ready=true;finish();}},onError:failure,onReconnecting:()=>{if(epoch===generation)ready=false;},onReconnected:()=>{if(epoch===generation && !closing)ready=true;} });
          void client.start({eventDispatcher:dispatcher}).catch(failure);
        } catch { failure(); }
      });
    },
    close(): void { closing=true; generation++; ready=false; cancelStart?.(); client?.close({force:true}); client=undefined; bound=undefined; },
  };
}
