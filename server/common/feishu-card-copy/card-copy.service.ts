import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AccessConfigurationService } from '../access/access-configuration.service';
import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';
import { FeishuCardCopyEngine } from './card-copy.engine';
import { FeishuCardMirrorStore } from './mirror.store';
import { registerCardCopyObserver } from './transport';
import { FeishuCardCopyFanout } from './fanout';
import { additionalReadonlyCardLedger, additionalReadonlyCardTargets } from './targets';

@Injectable()
export class FeishuCardCopyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuCardCopyService.name);
  private readonly engines: FeishuCardCopyEngine[] = [];
  private unregister?: () => void;
  private timer?: NodeJS.Timeout;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private tokenGeneration = 0;
  private readonly lastDiagnostics = new Map<string, number>();
  constructor(private readonly http: HttpService, @Optional() private readonly configuration?: AccessConfigurationService) {}
  async onModuleInit(): Promise<void> {
    const env = process.env;
    // Tests and previews cannot silently inherit production delivery credentials.
    if (env.NODE_ENV !== 'production' || env.FEISHU_CARD_READONLY_COPY_ENABLED !== 'true' || smokeMode()) return;
    const appId = env.FEISHU_APP_ID?.trim() || '', recipient = env.FEISHU_CARD_READONLY_COPY_OPEN_ID?.trim() || '';
    const name = env.FEISHU_CARD_READONLY_COPY_NAME?.trim() || '', expectedApp = env.FEISHU_CARD_READONLY_COPY_APP_ID?.trim() || '';
    if (!/^cli_[A-Za-z0-9_-]+$/.test(appId) || expectedApp !== appId || !/^ou_[A-Za-z0-9_-]+$/.test(recipient) || !name || !this.configuration) {
      this.diagnostic('CARD_COPY_CONFIGURATION_INCOMPLETE'); return;
    }
    const configurationFile = env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
    const file = env.FEISHU_CARD_READONLY_COPY_LEDGER_PATH || join(dirname(configurationFile), 'feishu-card-readonly-mirror.json');
    const protectedFiles = [configurationFile, env.PERSONNEL_SECURITY_FILE, env.PERSONNEL_PERMISSION_REQUESTS_FILE, env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE,
      env.PURCHASE_WORKFLOW_LEDGER_PATH, join(dirname(configurationFile), 'personnel-security.json'), join(dirname(configurationFile), 'personnel-permission-requests.json'),
      join(dirname(configurationFile), 'personnel-archive-corrections.json'), join(process.cwd(), '.runtime', 'purchase-workflow-ledger.json')].filter((p): p is string => !!p);
    if (!isAbsolute(file) || protectedFiles.some(p => resolve(p).toLowerCase() === resolve(file).toLowerCase())) { this.diagnostic('CARD_COPY_LEDGER_PATH_INVALID'); return; }
    let additional: ReturnType<typeof additionalReadonlyCardTargets> = [];
    try { additional = additionalReadonlyCardTargets(env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS); }
    catch { this.diagnostic('CARD_COPY_ADDITIONAL_TARGETS_INVALID'); }
    const targets = [{ name, openId: recipient, file }, ...additional.filter(target => target.openId !== recipient)
      .map(target => ({ ...target, file: additionalReadonlyCardLedger(file, appId, target.openId) }))];
    const validators: Array<() => boolean> = [];
    for (const target of targets) {
      const fingerprint = createHash('sha256').update(`${appId}\0${target.openId}`).digest('hex');
      const targetValid = () => {
        if (process.env.NODE_ENV !== 'production' || smokeMode() || process.env.FEISHU_APP_ID?.trim() !== appId ||
          process.env.FEISHU_CARD_READONLY_COPY_ENABLED !== 'true' || process.env.FEISHU_CARD_READONLY_COPY_APP_ID?.trim() !== expectedApp ||
          process.env.FEISHU_CARD_READONLY_COPY_OPEN_ID?.trim() !== recipient || process.env.FEISHU_CARD_READONLY_COPY_NAME?.trim() !== name) return false;
        try {
          if (target.openId !== recipient && !additionalReadonlyCardTargets(process.env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS)
            .some(item => item.openId === target.openId && item.name === target.name)) return false;
          return this.configuration!.isCurrentReadonlyCardRecipient({ appId, identityHash: fingerprint, name: target.name });
        } catch { return false; }
      };
      try {
        if (protectedFiles.some(p => resolve(p).toLowerCase() === resolve(target.file).toLowerCase())) throw new Error('CARD_COPY_LEDGER_PATH_INVALID');
        const store = new FeishuCardMirrorStore(resolve(target.file), { appId, recipientOpenId: target.openId });
        store.read();
        this.engines.push(new FeishuCardCopyEngine({ store, http: this.http.axiosRef, targetValid, accessToken: () => this.accessToken(appId), diagnostic: code => this.diagnostic(code) }));
        validators.push(targetValid);
      } catch { this.diagnostic('CARD_COPY_RECIPIENT_INITIALIZATION_FAILED'); }
    }
    if (!this.engines.length) return;
    try {
      this.unregister = registerCardCopyObserver(new FeishuCardCopyFanout(this.engines, code => this.diagnostic(code)));
      await runHotfixInitialization(this, async () => {
        if (validators.some(valid => !valid())) this.diagnostic('CARD_COPY_TARGET_UNAVAILABLE');
        this.timer = setInterval(() => { for (const engine of this.engines) void engine.flush(); }, 5_000); this.timer.unref?.();
      });
    } catch { this.unregister?.(); this.unregister = undefined; for (const engine of this.engines) engine.stop(); this.diagnostic('CARD_COPY_INITIALIZATION_FAILED'); }
  }
  async onModuleDestroy(): Promise<void> {
    for (const engine of this.engines) engine.stop(); this.unregister?.(); if (this.timer) clearInterval(this.timer);
    await cancelHotfixInitialization(this); this.token = undefined; this.tokenRequest = undefined; this.tokenGeneration++;
  }
  private async accessToken(appId: string): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    const secret = process.env.FEISHU_APP_SECRET?.trim(); if (!secret) throw new Error('CARD_COPY_AUTH_UNAVAILABLE');
    const generation = this.tokenGeneration;
    const request = (async () => {
      const response = await this.http.axiosRef.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, { timeout: 15_000, maxRedirects: 0 });
      if (response.data?.code !== 0 || typeof response.data?.tenant_access_token !== 'string') throw new Error('CARD_COPY_AUTH_UNAVAILABLE');
      const seconds = Number(response.data.expire);
      const token = { value: response.data.tenant_access_token, expiresAt: Date.now() + (Number.isFinite(seconds) ? Math.max(30, seconds - 300) : 300) * 1000 };
      if (generation === this.tokenGeneration) this.token = token;
      return token.value;
    })();
    this.tokenRequest = request;
    try { return await request; } finally { if (this.tokenRequest === request) this.tokenRequest = undefined; }
  }
  private diagnostic(code: string): void {
    const now = Date.now(); if (now - (this.lastDiagnostics.get(code) || 0) < 60_000) return;
    this.lastDiagnostics.set(code, now); this.logger.warn(`只读卡片抄送待核对：${code}；原业务投递保持不变`);
  }
}
function smokeMode(): boolean { return /^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || ''); }
