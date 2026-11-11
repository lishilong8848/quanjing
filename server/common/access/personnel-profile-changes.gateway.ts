import { PROFILE_CHANGE_PHOTO_MAX_BYTES } from '../../../shared/personnel-profile-change.interface';
import { createHash } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import FormData = require('form-data');
import {
  getTenantAccessToken,
  resolveBitableAppToken,
  invalidateBitableRecordCache,
  extractDisplayText,
  pickField,
  type BitableRecordItem,
} from '../feishu/bitable-direct-read';
import { readEmployeeOnboardingConfig } from '../../modules/bitable-sync/employee-onboarding.config';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import type { ProfileSource } from './personnel-profile-changes.store';
import type { ProfileChangeField } from '../../../shared/personnel-profile-change.interface';
const API = 'https://open.feishu.cn/open-apis';
const aliases: Record<ProfileChangeField, string[]> = {
  phone: ['联系方式', '电话', '手机号'],
  email: ['电子邮箱', '邮箱'],
  photo: [
    '照片',
    '证件照',
    '个人照片',
    '员工照片',
    '简历照片（一寸）',
    '简历照片',
  ],
};
export function profileValue(value: unknown, photo = false): unknown {
  return photo
    ? Array.isArray(value)
      ? value
          .map((v) => ({ file_token: v?.file_token }))
          .filter((v) => typeof v.file_token === 'string')
      : []
    : extractDisplayText(value).trim();
}
@Injectable()
export class PersonnelProfileChangesGateway {
  constructor(private readonly http: HttpService) {}
  async verifySource(source: ProfileSource) {
    const config = readEmployeeOnboardingConfig();
    const appToken = await resolveBitableAppToken(this.http, {
      ...config,
      requestTimeoutMs: () => 8000,
    });
    if (
      source.appId !== process.env.FEISHU_APP_ID?.trim() ||
      source.appToken !== appToken ||
      source.tableId !== config.tableId
    )
      throw new ConflictException('人员资料来源已变化，请重新申请');
  }
  private async config() {
    const token = await getTenantAccessToken(this.http, undefined, {
      requestTimeoutMs: () => 8000,
    });
    return {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
      maxRedirects: 0,
    };
  }
  async read(source: ProfileSource): Promise<BitableRecordItem> {
    await this.verifySource(source);
    const response = await this.http.axiosRef.get(
      `${API}/bitable/v1/apps/${source.appToken}/tables/${source.tableId}/records/${encodeURIComponent(source.recordId)}`,
      await this.config(),
    );
    if (
      response.data?.code !== 0 ||
      !response.data?.data?.record?.fields ||
      response.data?.data?.record?.record_id !== source.recordId
    )
      throw new ServiceUnavailableException('人员资料核对失败，请重试');
    const record = response.data.data.record;
    if (readPersonnelAuthorizationState(record.fields) !== 'active')
      throw new ConflictException('人员在职状态已变化');
    return record;
  }
  async fields(
    source: ProfileSource,
    keys: ProfileChangeField[],
    record: BitableRecordItem,
  ) {
    await this.verifySource(source);
    const metadata: any[] = [];
    let page: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.http.axiosRef.get(
        `${API}/bitable/v1/apps/${source.appToken}/tables/${source.tableId}/fields`,
        {
          ...(await this.config()),
          params: { page_size: 100, page_token: page },
        },
      );
      if (
        response.data?.code !== 0 ||
        !Array.isArray(response.data?.data?.items)
      )
        throw new ServiceUnavailableException('人员字段核对失败');
      metadata.push(...response.data.data.items);
      page = response.data.data.has_more
        ? response.data.data.page_token
        : undefined;
      if (
        response.data.data.has_more &&
        (typeof page !== 'string' || !page.trim())
      )
        throw new ServiceUnavailableException('人员字段分页不完整');
      if (page) {
        if (seen.has(page) || seen.size > 30)
          throw new ServiceUnavailableException('人员字段分页异常');
        seen.add(page);
      }
    } while (page);
    const result: Partial<Record<ProfileChangeField, string>> = {};
    for (const key of keys) {
      const names = aliases[key];
      const name =
        key === 'photo'
          ? names.find(
              (n) =>
                Array.isArray(record.fields?.[n]) &&
                (record.fields![n] as any[]).some(
                  (v) =>
                    typeof v?.file_token === 'string' &&
                    /^[A-Za-z0-9_-]{6,256}$/.test(v.file_token),
                ),
            ) ||
            names.find((n) =>
              metadata.some((f) => f.field_name === n && f.type === 17),
            )
          : names.find(
              (n) => pickField(record.fields || {}, [n]) !== undefined,
            ) || names.find((n) => metadata.some((f) => f.field_name === n));
      const field = metadata.find((f) => f.field_name === name);
      if (
        !field ||
        field.is_primary ||
        field.is_readonly ||
        field.property?.formula_expression ||
        !(key === 'photo' ? [17] : key === 'phone' ? [1, 13] : [1]).includes(
          field.type,
        )
      )
        throw new ConflictException('对应资料字段不可修改，请联系管理员');
      result[key] = name;
    }
    return result;
  }
  async write(source: ProfileSource, fields: Record<string, unknown>) {
    await this.verifySource(source);
    try {
      const response = await this.http.axiosRef.put(
        `${API}/bitable/v1/apps/${source.appToken}/tables/${source.tableId}/records/${encodeURIComponent(source.recordId)}`,
        { fields },
        await this.config(),
      );
      if (response.data?.code !== 0)
        throw new ServiceUnavailableException('资料写入结果待核对');
    } finally {
      invalidateBitableRecordCache({
        appToken: source.appToken,
        tableId: source.tableId,
        deletePersisted: true,
      });
    }
  }
  async verifyUploadedPhoto(
    source: ProfileSource,
    token: string,
    sha256: string,
    size: number,
  ) {
    if (!/^[A-Za-z0-9_-]{6,256}$/.test(token))
      throw new ConflictException('照片标识无效');
    await this.verifySource(source);
    const response = await this.http.axiosRef.get(
      `${API}/drive/v1/medias/${encodeURIComponent(token)}/download`,
      {
        ...(await this.config()),
        responseType: 'arraybuffer',
        maxContentLength: PROFILE_CHANGE_PHOTO_MAX_BYTES,
      },
    );
    const buffer = Buffer.from(response.data);
    if (
      buffer.length !== size ||
      createHash('sha256').update(buffer).digest('hex') !== sha256
    )
      throw new ConflictException('照片内容与原申请不一致');
  }
  async upload(
    source: ProfileSource,
    buffer: Buffer,
    type: string,
  ): Promise<string> {
    await this.verifySource(source);
    const form = new FormData();
    form.append(
      'file_name',
      'profile.' +
        (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'),
    );
    form.append('parent_type', 'bitable_image');
    form.append('parent_node', source.appToken);
    form.append('size', String(buffer.length));
    form.append('file', buffer, { filename: 'profile', contentType: type });
    const config = await this.config();
    const response = await this.http.axiosRef.post(
      `${API}/drive/v1/medias/upload_all`,
      form,
      {
        ...config,
        headers: { ...config.headers, ...form.getHeaders() },
        maxBodyLength: PROFILE_CHANGE_PHOTO_MAX_BYTES + 1024 * 1024,
      },
    );
    const token = response.data?.data?.file_token;
    if (response.data?.code !== 0 || typeof token !== 'string' || !token)
      throw new ServiceUnavailableException('照片上传结果待核对');
    return token;
  }
}
