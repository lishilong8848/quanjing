import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AccessConfigurationService } from '../access/access-configuration.service';
import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';
import { FeishuCardCopyEngine } from './card-copy.engine';
import { FeishuCardMirrorStore } from './mirror.store';
import { registerCardCopyObserver } from './transport';

@Injectable()
export class FeishuCardCopyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuCardCopyService.name);
  private engine?: FeishuCardCopyEngine;
  private unregister?: () => void;
  private timer?: NodeJS.Timeout;
  private token?: { value: string; expiresAt: number };
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
    const fingerprint = createHash('sha256').update(`${appId}\0${recipient}`).digest('hex');
    const targetValid = () => {
      if (process.env.NODE_ENV !== 'production' || smokeMode() || process.env.FEISHU_APP_ID?.trim() !== appId ||
          process.env.FEISHU_CARD_READONLY_COPY_ENABLED !== 'true' || process.env.FEISHU_CARD_READONLY_COPY_APP_ID?.trim() !== expectedApp ||
          process.env.FEISHU_CARD_READONLY_COPY_OPEN_ID?.trim() !== recipient || process.env.FEISHU_CARD_READONLY_COPY_NAME?.trim() !== name) return false;
      try {
        const state = this.configuration!.snapshot();
        const matches = state.accounts.filter(account => account.kind === 'feishu' && account.appId === appId && account.identityHash === fingerprint && account.name === name &&
          account.enabled && !account.deleted && !account.reactivationRequired && !account.permissionsRevoked && account.personnelActive !== false);
        return matches.length === 1 && !!this.configuration!.currentPrincipal(matches[0].id, matches[0].version);
      } catch { return false; }
    };
    try {
      const store = new FeishuCardMirrorStore(resolve(file), { appId, recipientOpenId: recipient });
      store.read();
      this.engine = new FeishuCardCopyEngine({ store, http: this.http.axiosRef, targetValid, accessToken: () => this.accessToken(appId), diagnostic: code => this.diagnostic(code) });
      this.unregister = registerCardCopyObserver(this.engine);
      await runHotfixInitialization(this, async () => {
        if (!targetValid()) this.diagnostic('CARD_COPY_TARGET_UNAVAILABLE');
        this.timer = setInterval(() => { void this.engine?.flush(); }, 5_000); this.timer.unref?.();
      });
    } catch { this.unregister?.(); this.unregister = undefined; this.engine?.stop(); this.diagnostic('CARD_COPY_INITIALIZATION_FAILED'); }
  }
  async onModuleDestroy(): Promise<void> {
    this.engine?.stop(); this.unregister?.(); if (this.timer) clearInterval(this.timer);
    await cancelHotfixInitialization(this); this.token = undefined;
  }
  private async accessToken(appId: string): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const secret = process.env.FEISHU_APP_SECRET?.trim(); if (!secret) throw new Error('CARD_COPY_AUTH_UNAVAILABLE');
    const response = await this.http.axiosRef.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, { timeout: 15_000, maxRedirects: 0 });
    if (response.data?.code !== 0 || typeof response.data?.tenant_access_token !== 'string') throw new Error('CARD_COPY_AUTH_UNAVAILABLE');
    const seconds = Number(response.data.expire);
    this.token = { value: response.data.tenant_access_token, expiresAt: Date.now() + (Number.isFinite(seconds) ? Math.max(30, seconds - 300) : 300) * 1000 };
    return this.token.value;
  }
  private diagnostic(code: string): void {
    const now = Date.now(); if (now - (this.lastDiagnostics.get(code) || 0) < 60_000) return;
    this.lastDiagnostics.set(code, now); this.logger.warn(`只读卡片抄送待核对：${code}；原业务投递保持不变`);
  }
}
function smokeMode(): boolean { return /^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || ''); }
