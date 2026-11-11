import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type {
  ManagedAccount,
  ConfigurationPerson,
} from '../../../shared/access-configuration.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { PersonnelArchiveGateway } from './personnel-archive.gateway';
import {
  PersonnelProfileChangesStore,
  type StoredProfileChange,
} from './personnel-profile-changes.store';
import {
  PersonnelProfileNotificationStore,
  type ProfileNotificationDelivery,
} from './personnel-profile-notification.store';
import {
  profileChangeCard,
  profileChangeReviewUrl,
} from './personnel-profile-notification.card';
import {
  observedCardPost,
  observedCardPatch,
} from '../feishu-card-copy/transport';
import {
  runHotfixInitialization,
  cancelHotfixInitialization,
} from '../hotfix-runtime-activation';
import {
  getRecordId,
  pickField,
  extractDisplayText,
} from '../feishu/bitable-direct-read';
const API = 'https://open.feishu.cn/open-apis';
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const enabled = () =>
  process.env.NODE_ENV === 'production' &&
  !/^(1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '');
@Injectable()
export class PersonnelProfileNotificationsService {
  private store?: PersonnelProfileNotificationStore;
  private timer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;
  private token?: { value: string; appId: string; expiresAt: number };
  private diagnosticAt = 0;
  private registrationCursor = '';
  private logger = new Logger(PersonnelProfileNotificationsService.name);
  constructor(
    private readonly http: HttpService,
    private readonly configuration: AccessConfigurationService,
    private readonly directory: AccessConfigurationDirectory,
    private readonly archive: PersonnelArchiveGateway,
    private readonly requests: PersonnelProfileChangesStore,
  ) {}
  async onModuleInit() {
    if (!enabled()) return;
    const config =
      process.env.ACCESS_CONFIGURATION_FILE ||
      join(process.cwd(), '.runtime', 'access-configuration.json');
    try {
      this.store = new PersonnelProfileNotificationStore(
        resolve(dirname(config), 'personnel-profile-notifications.json'),
      );
      this.store.read();
    } catch {
      this.diagnostic();
      return;
    }
    await runHotfixInitialization(this, () => {
      this.stopped = false;
      this.timer = setInterval(() => this.wake(), 30000);
      this.timer.unref();
      this.wake();
    });
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await cancelHotfixInitialization(this);
    if (this.running) await this.running;
    this.token = undefined;
  }
  wake() {
    if (this.stopped || !enabled() || !this.store || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.flush();
    }, 0);
    this.wakeTimer.unref();
  }
  private administrator(
    account: ManagedAccount | undefined,
    appId: string,
  ): account is ManagedAccount {
    return (
      !!account &&
      account.kind === 'feishu' &&
      account.appId === appId &&
      account.role === 'admin' &&
      account.enabled &&
      !account.deleted &&
      !account.reactivationRequired &&
      !account.permissionsRevoked &&
      account.personnelActive !== false &&
      this.configuration.currentPrincipal(account.id, account.version)?.role ===
        'admin'
    );
  }
  private validRecipient(
    entry: ProfileNotificationDelivery,
    row: StoredProfileChange,
    appId: string,
  ) {
    const account = this.configuration
      .snapshot()
      .accounts.find((a) => a.id === entry.accountId);
    return (
      this.administrator(account, appId) &&
      !this.related(account, row) &&
      account.identityHash === digest(`${appId}\0${entry.openId}`)
    );
  }
  private related(
    account: ManagedAccount,
    row: StoredProfileChange,
    applicantOpenId?: string,
  ) {
    return (
      account.id === row.accountId ||
      account.id === row.identity ||
      account.personnelIdentity === row.identity ||
      (!!applicantOpenId &&
        account.identityHash ===
          digest(`${row.source.appId}\0${applicantOpenId}`))
    );
  }
  private async registerPending() {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    const pending = Object.values(this.requests.read().requests).filter(
      (row) => row.status === 'pending' && row.source.appId === appId,
    );
    if (!pending.length) return;
    const snapshot = this.configuration.snapshot();
    let accounts = snapshot.accounts.filter((a) =>
      this.administrator(a, appId),
    );
    if (!accounts.length) return;
    if (accounts.some((a) => !a.openId)) {
      const directory = await boundedRead<{
        appId: string;
        personnelComplete?: boolean;
        people: ConfigurationPerson[];
      }>(this.directory.read());
      if (directory.appId !== appId || !directory.personnelComplete)
        throw new Error('DIRECTORY_INCOMPLETE');
      accounts = accounts.map((a) => {
        const match = directory.people.filter(
          (p) => digest(`${appId}\0${p.openId}`) === a.identityHash,
        );
        return !a.openId && match.length === 1
          ? { ...a, openId: match[0].openId }
          : a;
      });
    }
    if (this.stopped) return;
    const source = await boundedRead(this.archive.read());
    if (source.appId !== appId) throw new Error('SOURCE_IDENTITY_CHANGED');
    pending.sort((a, b) => a.id.localeCompare(b.id));
    let batch = pending
      .filter((row) => row.id > this.registrationCursor)
      .slice(0, 100);
    if (!batch.length) {
      this.registrationCursor = '';
      batch = pending.slice(0, 100);
    }
    for (const row of batch) {
      if (this.stopped) return;
      this.registrationCursor = row.id;
      if (
        source.appToken !== row.source.appToken ||
        source.tableId !== row.source.tableId
      )
        continue;
      const record = source.records.find(
        (r) => getRecordId(r) === row.source.recordId,
      );
      if (!record) continue;
      const fields = record.fields || {},
        users = pickField(fields, ['员工姓名', '员工', '人员']),
        ids = new Set<string>();
      if (Array.isArray(users))
        for (const user of users)
          if (typeof user?.id === 'string') ids.add(user.id);
      const explicit = extractDisplayText(
        pickField(fields, ['飞书 open_id', 'open_id', 'Open ID']),
      ).trim();
      if (explicit) ids.add(explicit);
      if (ids.size > 1) continue;
      const applicantOpenId = [...ids][0];
      const recipients = [
        ...new Map(
          accounts
            .filter(
              (a) =>
                !this.related(a, row, applicantOpenId) &&
                a.openId &&
                /^ou_[A-Za-z0-9_-]+$/.test(a.openId) &&
                a.identityHash === digest(`${appId}\0${a.openId}`),
            )
            .map((a) => [a.openId!, a]),
        ).values(),
      ];
      if (!recipients.length) continue;
      const current = this.requests.read().requests[row.id];
      if (!current || current.status !== 'pending') continue;
      const prior = this.store!.read().jobs[row.id];
      if (
        prior &&
        recipients.every((a) =>
          prior.deliveries.some((d) => d.openId === a.openId),
        )
      )
        continue;
      this.store!.update((state) => {
        let job = state.jobs[row.id];
        if (!job) {
          job = {
            requestId: row.id,
            appId,
            createdAt: Date.now(),
            recipientAccountIds: [],
            recipientsResolved: true,
            deliveries: [],
          };
          state.jobs[row.id] = job;
        }
        if (job.appId !== appId) return;
        for (const account of recipients) {
          if (!job.recipientAccountIds.includes(account.id))
            job.recipientAccountIds.push(account.id);
          if (job.deliveries.some((d) => d.openId === account.openId)) continue;
          job.deliveries.push({
            accountId: account.id,
            openId: account.openId!,
            uuid: digest(
              `profile-change\0${appId}\0${row.id}\0${account.openId}`,
            ).slice(0, 40),
            attempts: 0,
            nextAttemptAt: 0,
            status: 'queued',
          });
        }
      });
    }
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped || !enabled() || !this.store) return Promise.resolve();
    const task = this.drain()
      .catch(() => this.diagnostic())
      .finally(() => {
        if (this.running === task) this.running = undefined;
      });
    this.running = task;
    return task;
  }
  private async drain() {
    try {
      await this.registerPending();
    } catch {
      this.diagnostic();
    }
    if (this.stopped || !this.store) return;
    let work = 0;
    for (const job of Object.values(this.store.read().jobs)) {
      if (job.appId !== process.env.FEISHU_APP_ID?.trim()) continue;
      for (const delivery of job.deliveries) {
        if (this.stopped || work >= 20) return;
        const row = this.requests.read().requests[job.requestId];
        if (
          !row ||
          delivery.status === 'attention' ||
          delivery.status === 'cancelled' ||
          delivery.nextAttemptAt > Date.now() ||
          (delivery.syncedVersion === row.version &&
            this.validRecipient(delivery, row, job.appId))
        )
          continue;
        work++;
        try {
          await this.store.withDeliveryLock(job.requestId, delivery.uuid, () =>
            this.deliver(job.requestId, delivery.uuid),
          );
        } catch {
          this.diagnostic();
        }
      }
    }
  }
  private async deliver(id: string, uuid: string) {
    const store = this.store!,
      job = store.read().jobs[id],
      entry = job?.deliveries.find((d) => d.uuid === uuid);
    let row = this.requests.read().requests[id];
    if (
      !row ||
      !entry ||
      this.stopped ||
      ['cancelled', 'attention'].includes(entry.status)
    )
      return;
    const update = (fn: (d: ProfileNotificationDelivery) => void) =>
      store.update((state) => {
        const d = state.jobs[id]?.deliveries.find((x) => x.uuid === uuid);
        if (d) fn(d);
      });
    const eligible = () => {
      const account = this.configuration
        .snapshot()
        .accounts.find((a) => a.id === entry.accountId);
      return (
        this.administrator(account, job.appId) &&
        !this.related(account, row) &&
        account.identityHash === digest(`${job.appId}\0${entry.openId}`)
      );
    };
    if (
      !entry.messageId &&
      !entry.firstAttemptAt &&
      (row.status !== 'pending' || !eligible())
    ) {
      update((d) => {
        d.status = 'cancelled';
        d.errorCode = 'NO_PENDING_REVIEW';
      });
      return;
    }
    if (!entry.messageId && entry.firstAttemptAt && row.status !== 'pending') {
      update((d) => {
        d.status = 'attention';
        d.errorCode = 'TERMINAL_REQUEST_SEND_UNKNOWN';
      });
      return;
    }
    if (
      !entry.messageId &&
      entry.firstAttemptAt &&
      (Date.now() - entry.firstAttemptAt > 5 * 60000 || entry.attempts >= 3)
    ) {
      update((d) => {
        d.status = 'attention';
        d.errorCode = 'SEND_RESULT_REQUIRES_REVIEW';
      });
      return;
    }
    if (!entry.messageId && !eligible()) {
      update((d) => {
        d.status = 'attention';
        d.errorCode = 'RECIPIENT_CHANGED_WITH_UNKNOWN_SEND';
      });
      return;
    }
    try {
      const token = await this.accessToken(job.appId);
      if (
        this.stopped ||
        !enabled() ||
        process.env.FEISHU_APP_ID?.trim() !== job.appId
      )
        return;
      row = this.requests.read().requests[id];
      if (!row) return;
      const headers = { Authorization: `Bearer ${token}` };
      let messageId = entry.messageId;
      if (!messageId) {
        if (row.status !== 'pending' || !eligible()) {
          update((d) => {
            d.status = 'cancelled';
            d.errorCode = 'NO_PENDING_REVIEW';
          });
          return;
        }
        const card =
            entry.pendingCard ||
            profileChangeCard(row, profileChangeReviewUrl(id)),
          version = entry.pendingVersion || row.version;
        update((d) => {
          d.status = 'sending';
          d.firstAttemptAt ??= Date.now();
          d.attempts++;
          d.pendingCard = card;
          d.pendingVersion = version;
        });
        const response = await observedCardPost(
          this.http.axiosRef,
          'profile-change',
          API + '/im/v1/messages',
          {
            receive_id: entry.openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
            uuid,
          },
          {
            headers,
            params: { receive_id_type: 'open_id' },
            timeout: 8000,
            maxRedirects: 0,
          },
        );
        messageId = response.data?.data?.message_id;
        if (
          response.data?.code !== 0 ||
          typeof messageId !== 'string' ||
          !/^om_[A-Za-z0-9_-]+$/.test(messageId)
        )
          throw new Error('SEND_NOT_CONFIRMED');
        update((d) => {
          d.messageId = messageId;
          d.status = 'sent';
          d.syncedVersion = version;
          d.nextAttemptAt = 0;
          delete d.pendingCard;
          delete d.pendingVersion;
          delete d.errorCode;
        });
      }
      const latest = this.requests.read().requests[id];
      if (!latest) return;
      row = latest;
      const revoked = !eligible();
      const saved = store
        .read()
        .jobs[id].deliveries.find((d) => d.uuid === uuid)!;
      if (saved.syncedVersion !== latest.version || revoked) {
        const response = await observedCardPatch(
          this.http.axiosRef,
          'profile-change',
          API + '/im/v1/messages/' + messageId,
          {
            content: JSON.stringify(
              profileChangeCard(latest, profileChangeReviewUrl(id), revoked),
            ),
          },
          { headers, timeout: 8000, maxRedirects: 0 },
        );
        if (response.data?.code !== 0) throw new Error('UPDATE_NOT_CONFIRMED');
        update((d) => {
          d.status = revoked ? 'cancelled' : 'sent';
          d.syncedVersion = latest.version;
          d.nextAttemptAt = 0;
          delete d.errorCode;
        });
      }
    } catch {
      update((d) => {
        d.nextAttemptAt = Date.now() + 30000;
        d.errorCode = d.messageId ? 'CARD_UPDATE_PENDING' : 'CARD_SEND_PENDING';
      });
      this.diagnostic();
    }
  }
  private async accessToken(appId: string) {
    if (this.token?.appId === appId && this.token.expiresAt > Date.now())
      return this.token.value;
    const secret = process.env.FEISHU_APP_SECRET?.trim();
    if (!secret) throw new Error('AUTH_UNAVAILABLE');
    const response = await this.http.axiosRef.post(
      API + '/auth/v3/tenant_access_token/internal',
      { app_id: appId, app_secret: secret },
      { timeout: 8000, maxRedirects: 0 },
    );
    if (
      response.data?.code !== 0 ||
      typeof response.data.tenant_access_token !== 'string'
    )
      throw new Error('AUTH_UNAVAILABLE');
    const expire = Number(response.data.expire);
    this.token = {
      appId,
      value: response.data.tenant_access_token,
      expiresAt:
        Date.now() +
        Math.max(
          0,
          Math.min(300, Number.isFinite(expire) ? expire - 30 : 300),
        ) *
          1000,
    };
    return this.token.value;
  }
  private diagnostic() {
    if (Date.now() - this.diagnosticAt < 60000) return;
    this.diagnosticAt = Date.now();
    this.logger.warn(
      '资料变更管理员通知待同步，原申请保持不变，请在平台资料变更审批中核对',
    );
  }
}

async function boundedRead<T>(read: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('PROFILE_NOTIFICATION_DIRECTORY_TIMEOUT')),
          50000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
