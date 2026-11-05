import type { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import type { LifecyclePaymentUploadGatewayPort, LifecyclePaymentUploadReceivedFile } from './purchase-lifecycle-payment-upload-isolated';
import type { LifecyclePaymentUploadIdentity } from './purchase-lifecycle-payment-upload-isolated';
import type { LifecyclePaymentPerFileGatewayPort } from './purchase-lifecycle-payment-upload-per-file';
import type { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import FormData = require('form-data');
import { getFeishuAuthPayload, parseFeishuBitableLink, readEnv } from '../../common/config/external-services.config';

type PaymentSource = { appId: string; appToken: string; tableId: string };
function paymentSource(): PaymentSource {
  const value = { appId: readEnv('FEISHU_APP_ID'), appToken: readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || parseFeishuBitableLink(readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL')).appToken, tableId: readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID') };
  if (!/^cli_[A-Za-z0-9_-]+$/.test(value.appId) || !/^[A-Za-z0-9_-]{1,160}$/.test(value.appToken) || !/^[A-Za-z0-9_-]{1,160}$/.test(value.tableId)) throw new Error('付款附件数据源不可用');
  return value;
}
const fingerprint = (source: PaymentSource) => createHash('sha256').update(JSON.stringify([source.appId, source.appToken, source.tableId])).digest('hex');
export function lifecyclePaymentUploadSourceFingerprint(): string { return fingerprint(paymentSource()); }

/** Direct per-file transport. The cached token of a different app must never be
 * paired with a newly selected Base. No automatic remote-write retry occurs. */
export class LifecyclePaymentPerFileGatewayAdapter implements LifecyclePaymentPerFileGatewayPort {
  constructor(private readonly http: Pick<HttpService, 'axiosRef'>,
    private readonly readSource: () => PaymentSource = paymentSource,
    private readonly readCredentials: () => { app_id: string; app_secret: string } = getFeishuAuthPayload,
    private readonly verifyPersistedSource?: (appId:string,fingerprint:string)=>Promise<void>) {}

  async uploadOne(file: LifecyclePaymentUploadReceivedFile, attemptId: string, identity: LifecyclePaymentUploadIdentity): Promise<string> {
    if (!identity || typeof identity.assertCurrent !== 'function' || typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(attemptId) ||
      !file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size < 1 || file.size > 20 * 1024 * 1024 || typeof file.originalname !== 'string' || !file.originalname.trim() || /[\u0000-\u001f\u007f/\\]/u.test(file.originalname) || typeof file.mimetype !== 'string' || !file.mimetype) throw new Error('付款附件上传来源不可用');
    const source = { ...this.readSource() }, credentials = { ...this.readCredentials() }, binding = fingerprint(source);
    if (source.appId !== identity.appId || identity.uploadSourceFingerprint !== binding || credentials.app_id !== source.appId || !credentials.app_secret) throw new Error('付款附件上传来源已变化');
    const current = () => {
      identity.assertCurrent(); const next = this.readCredentials();
      if (fingerprint(this.readSource()) !== binding || next.app_id !== credentials.app_id || next.app_secret !== credentials.app_secret) throw new Error('付款附件上传来源已变化');
    };
    current();
    if(this.verifyPersistedSource) await this.verifyPersistedSource(source.appId,binding);
    current();
    let token: string;
    try {
      const auth = await this.http.axiosRef.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', credentials, { timeout: 15000, maxRedirects: 0 });
      if (auth.data?.code !== 0 || typeof auth.data.tenant_access_token !== 'string' || !auth.data.tenant_access_token) throw new Error();
      token = auth.data.tenant_access_token;
    } catch { throw new Error('付款附件上传认证失败'); }
    current();
    if(this.verifyPersistedSource) await this.verifyPersistedSource(source.appId,binding);
    current();
    const form = new FormData();
    form.append('file_name', file.originalname); form.append('parent_type', 'bitable_file'); form.append('parent_node', source.appToken); form.append('size', String(file.size));
    form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    current();
    let response;
    try {
      response = await this.http.axiosRef.post('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', form, { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }, timeout: 60000, maxBodyLength: 21 * 1024 * 1024, maxRedirects: 0 });
    } catch { throw new Error('付款附件上传结果待核对'); }
    if (response.data?.code !== 0 || typeof response.data.data?.file_token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(response.data.data.file_token)) throw new Error('付款附件上传结果待核对');
    // Preserve a confirmed receipt even if permission changes while the upload
    // runs. The store reauthorizes separately before attaching it to the record.
    return response.data.data.file_token;
  }
}

/** No automatic retry: a partial or unknown external result must be reconciled by the durable task. */
export class LifecyclePaymentUploadGatewayAdapter implements LifecyclePaymentUploadGatewayPort {
  constructor(private readonly gateway: Pick<PurchaseWorkflowGateway, 'getTenantAccessTokenAsApp' | 'uploadAttachment'>) {}

  async upload(files: readonly LifecyclePaymentUploadReceivedFile[], attemptId: string): Promise<string[]> {
    if (!this.gateway || typeof this.gateway.getTenantAccessTokenAsApp !== 'function' || typeof this.gateway.uploadAttachment !== 'function' ||
      typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(attemptId) ||
      !Array.isArray(files) || files.length < 1 || files.length > 5) throw new Error('付款附件上传来源不可用');
    for (const file of files) {
      if (!file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size < 1 || file.size > 20 * 1024 * 1024 ||
        typeof file.originalname !== 'string' || !file.originalname.trim() || /[\u0000-\u001f\u007f/\\]/u.test(file.originalname) || typeof file.mimetype !== 'string' || !file.mimetype) throw new Error('付款附件上传文件无效');
    }
    const credential = await this.gateway.getTenantAccessTokenAsApp();
    if (typeof credential !== 'string' || !credential) throw new Error('付款附件上传凭据不可用');
    const tokens: string[] = [];
    for (const file of files) {
      const token = await this.gateway.uploadAttachment(file, credential);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(token) || tokens.includes(token)) throw new Error('付款附件上传结果不可核对');
      tokens.push(token);
    }
    return tokens;
  }

  /** Called only after the individual file's durable dispatch fence is committed. */
  async uploadOne(file: LifecyclePaymentUploadReceivedFile, attemptId: string): Promise<string> {
    const result = await this.upload([file], attemptId);
    return result[0]!;
  }
}
