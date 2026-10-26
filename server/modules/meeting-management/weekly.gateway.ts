import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import FormData from 'form-data';
import {
  fetchBitableRecords,
  getTenantAccessToken,
  invalidateBitableRecordCache,
} from '../../common/feishu/bitable-direct-read';
import {
  buildActivePersonnelDirectory,
  DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
  DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
} from '../bitable-sync/active-personnel-directory';
import { WEEKLY_MEETING_SOURCE } from './meeting.service';
import { text as fieldText, documentUrl } from './meeting.mapper';

@Injectable()
export class WeeklyGateway {
  constructor(private readonly http: HttpService) {}
  async creationLink(mutationId: string, recordId: string): Promise<string> {
    const result = await this.request(
      'POST',
      'records/search',
      {
        field_names: ['周报生成标识'],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '周报生成标识', operator: 'is', value: [mutationId] },
          ],
        },
      },
      { page_size: 2 },
    );
    if (
      !Array.isArray(result.items) ||
      result.has_more ||
      result.items.length !== 1 ||
      result.items[0].record_id !== recordId
    )
      throw new Error('新建条目链接未确认，请核对记录后重试群提醒');
    const link = result.items[0].record_url;
    if (!link)
      return 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
    if (
      typeof link !== 'string' ||
      !/^https:\/\/vnet\.feishu\.cn\/(?:base|wiki)\/[A-Za-z0-9]+(?:\?[^\s]*)?$/.test(
        link,
      )
    )
      throw new Error('飞书尚未返回有效条目链接，请重试群提醒');
    return link;
  }
  async sendWeeklyReport(
    chatId: string,
    uuid: string,
    title: string,
    documentUrl: string,
  ): Promise<string> {
    if (
      !/^oc_[a-f0-9]{32}$/.test(chatId) ||
      !/^[a-f0-9]{32}$/.test(uuid) ||
      !(
        /^https:\/\/vnet\.feishu\.cn\/docx\/[A-Za-z0-9]+$/.test(documentUrl) ||
        /^https:\/\/vnet\.feishu\.cn\/(?:base|wiki)\/[A-Za-z0-9]+(?:\?[^\s]*)?$/.test(
          documentUrl,
        )
      )
    )
      throw Object.assign(new Error('周报提醒参数无效'), {
        notificationRejected: true,
      });
    let token: string;
    try {
      token = await getTenantAccessToken(this.http);
    } catch {
      throw Object.assign(new Error('群提醒认证失败，请检查飞书应用配置'), {
        notificationRejected: true,
      });
    }
    const result = await this.http.axiosRef
      .request({
        method: 'POST',
        url: 'https://open.feishu.cn/open-apis/im/v1/messages',
        params: { receive_id_type: 'chat_id' },
        timeout: 20000,
        headers: { Authorization: `Bearer ${token}` },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          uuid,
          content: JSON.stringify({
            text: `${title}\n${documentUrl}\n请各专业示例人员019更新本周内容和待办。`,
          }),
        },
      })
      .catch((error) => {
        const status = (error as { response?: { status?: number } }).response
          ?.status;
        if (status && status >= 400 && status < 500 && status !== 408)
          throw Object.assign(
            new Error(
              `群提醒请求被拒绝（HTTP ${status}），请检查机器人权限后重试`,
            ),
            { notificationRejected: true },
          );
        throw error;
      });
    if (result.data?.code !== 0)
      throw Object.assign(
        new Error(
          `飞书群提醒发送未通过（错误码${Number(result.data?.code) || '未知'}），请检查机器人群成员和发送权限`,
        ),
        { notificationRejected: true },
      );
    const id = result.data.data?.message_id;
    if (typeof id !== 'string' || !/^om_[A-Za-z0-9]+$/.test(id))
      throw new Error('群提醒发送结果未确认');
    return id;
  }
  private url(suffix: string) {
    return `https://open.feishu.cn/open-apis/bitable/v1/apps/${WEEKLY_MEETING_SOURCE.appToken}/tables/${WEEKLY_MEETING_SOURCE.tableId}/${suffix}`;
  }
  private async request(
    method: 'GET' | 'PUT' | 'POST',
    suffix: string,
    data?: unknown,
    params?: Record<string, unknown>,
  ) {
    const token = await getTenantAccessToken(this.http);
    const read = method === 'GET' || suffix === 'records/search';
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.http.axiosRef.request({
          method,
          url: this.url(suffix),
          data,
          params,
          timeout: read ? 20000 : 30000,
          headers: { Authorization: `Bearer ${token}` },
        });
        break;
      } catch (error) {
        const value = error as {
          code?: string;
          response?: { status?: number };
        };
        const transient =
          [
            'ECONNABORTED',
            'ETIMEDOUT',
            'ECONNRESET',
            'EAI_AGAIN',
            'ERR_NETWORK',
          ].includes(value.code || '') ||
          [429, 500, 502, 503, 504].includes(value.response?.status || 0);
        if (!read || !transient) throw error;
        if (attempt >= 2)
          throw new Error(
            '飞书查询超时或暂时不可用，任务和附件已保留，请重试失败步骤',
          );
        await new Promise((resolve) =>
          setTimeout(resolve, (attempt + 1) * 300),
        );
      }
    }
    if (result.data?.code !== 0 || !result.data?.data)
      throw Object.assign(
        new Error(
          `飞书多维表请求未通过（错误码${Number(result.data?.code) || '未知'}），请检查字段或权限`,
        ),
        { operationRejected: true },
      );
    return result.data.data;
  }
  async record(id: string): Promise<Record<string, unknown>> {
    const data = await this.request('GET', `records/${id}`);
    if (data.record?.record_id !== id || !data.record.fields)
      throw new Error('目标周报回读失败');
    const fields = data.record.fields;
    if (fieldText(fields['链接']).trim() && !documentUrl(fields['链接'])) {
      const access = await getTenantAccessToken(this.http);
      const response = await this.http.axiosRef.request({
        method: 'POST',
        url: `https://open.feishu.cn/open-apis/base/v3/bases/${WEEKLY_MEETING_SOURCE.appToken}/tables/${WEEKLY_MEETING_SOURCE.tableId}/records/batch_get`,
        data: { record_id_list: [id] },
        headers: { Authorization: `Bearer ${access}` },
        timeout: 10000,
      });
      const result = response.data?.data;
      const index = result?.record_id_list?.indexOf(id);
      const field = result?.fields?.indexOf('链接');
      if (
        response.data?.code !== 0 ||
        index === undefined ||
        index < 0 ||
        field === undefined ||
        field < 0 ||
        !Array.isArray(result.data?.[index])
      )
        throw new Error('原始周报链接回读失败，请核对后重试');
      const value = result.data[index][field];
      if (fieldText(value).trim() && !documentUrl(value))
        throw new Error('已有周报链接无法识别，请核对后重试');
      fields['链接'] = value;
    }
    return fields;
  }
  async ensureCreationField() {
    let page: string | undefined;
    let found = false;
    do {
      const result = await this.request('GET', 'fields', undefined, {
        page_size: 100,
        ...(page ? { page_token: page } : {}),
      });
      if (!Array.isArray(result.items)) throw new Error('周报字段读取失败');
      const field = result.items.find(
        (item: { field_name: string }) => item.field_name === '周报生成标识',
      );
      if (field && field.type !== 1)
        throw new Error('周报生成标识须为文本字段');
      if (field) found = true;
      if (result.has_more && (!result.page_token || result.page_token === page))
        throw new Error('周报字段分页失败');
      page = result.has_more ? result.page_token : undefined;
    } while (page);
    if (!found)
      await this.request('POST', 'fields', {
        field_name: '周报生成标识',
        type: 1,
      });
  }
  async findCreated(mutationId: string): Promise<string | null> {
    const result = await this.request(
      'POST',
      'records/search',
      {
        field_names: ['周报生成标识'],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '周报生成标识', operator: 'is', value: [mutationId] },
          ],
        },
      },
      { page_size: 2 },
    );
    if (
      !Array.isArray(result.items) ||
      result.has_more ||
      result.items.length > 1
    )
      throw new Error('周报生成标识重复或查询不完整');
    const row = result.items[0];
    if (row && this.text(row.fields?.['周报生成标识']) !== mutationId)
      throw new Error('周报生成标识回读失败');
    return row?.record_id || null;
  }
  async assertNoDate(endDate: string) {
    const records = await fetchBitableRecords(this.http, {
      ...WEEKLY_MEETING_SOURCE,
      forceRefresh: true,
      strict: true,
      allowStale: false,
    });
    if (
      records.some((record) => {
        const value = record.fields?.['日期'];
        if (typeof value === 'number')
          return (
            new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Asia/Shanghai',
            }).format(new Date(value)) === endDate
          );
        return this.text(value) === endDate;
      })
    )
      throw new Error('该日期已有周报，请从列表明确选择目标条目');
  }
  async createRow(
    endDate: string,
    mutationId: string,
    onCreated?: (id: string) => void,
  ): Promise<string> {
    const result = await this.request('POST', 'records', {
      fields: {
        日期: new Date(`${endDate}T00:00:00+08:00`).getTime(),
        周报生成标识: mutationId,
      },
    });
    const id = result.record?.record_id;
    if (typeof id === 'string' && /^rec[A-Za-z0-9]+$/.test(id)) onCreated?.(id);
    if (
      !id ||
      this.text((await this.record(id))['周报生成标识']) !== mutationId
    )
      throw new Error('周报条目创建未确认');
    invalidateBitableRecordCache({
      appToken: WEEKLY_MEETING_SOURCE.appToken,
      tableId: WEEKLY_MEETING_SOURCE.tableId,
      deletePersisted: true,
    });
    return id;
  }
  async grantDocument(documentUrl: string, editors: string[]) {
    const token = documentUrl.match(
      /^https:\/\/vnet\.feishu\.cn\/docx\/([A-Za-z0-9]+)$/,
    )?.[1];
    if (!token) throw new Error('周报文档链接无效');
    const access = await getTenantAccessToken(this.http);
    const url = `https://open.feishu.cn/open-apis/drive/v1/permissions/${token}/members`;
    const request = async (method: 'GET' | 'POST', data?: unknown) => {
      try {
        const response = await this.http.axiosRef.request({
          method,
          url,
          data,
          params: {
            type: 'docx',
            ...(method === 'POST' ? { need_notification: false } : {}),
          },
          headers: { Authorization: `Bearer ${access}` },
          timeout: 10000,
        });
        if (response.data?.code !== 0 || !response.data.data) throw new Error();
        return response.data.data;
      } catch {
        throw new Error('周报文档权限未确认，请检查应用共享权限后重试');
      }
    };
    const initial = await request('GET');
    if (!Array.isArray(initial.items)) throw new Error('周报权限列表回读失败');
    const matches = (
      items: { member_type: string; member_id: string; perm: string }[],
      openId: string,
    ) =>
      items.some(
        (member) =>
          member.member_type === 'openid' &&
          member.member_id === openId &&
          ['edit', 'full_access'].includes(member.perm),
      );
    for (const openId of editors)
      if (!matches(initial.items, openId))
        await request('POST', {
          member_type: 'openid',
          member_id: openId,
          perm: 'edit',
          type: 'user',
        });
    const result = await request('GET');
    if (
      !Array.isArray(result.items) ||
      !editors.every((openId) => matches(result.items, openId))
    )
      throw new Error('周报编辑权限回读不一致');
  }
  text(value: unknown): string {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { link?: unknown }).link === 'string'
    )
      return String((value as { link: string }).link).trim();
    return fieldText(value).replace(/\r\n/g, '\n').trim();
  }
  async update(
    id: string,
    expected: Record<string, string>,
    desired: Record<string, string>,
  ) {
    const types = new Map<string, number>();
    let page: string | undefined;
    do {
      const data = await this.request('GET', 'fields', undefined, {
        page_size: 100,
        ...(page ? { page_token: page } : {}),
      });
      if (!Array.isArray(data.items)) throw new Error('周报字段读取失败');
      for (const field of data.items) types.set(field.field_name, field.type);
      if (data.has_more && (!data.page_token || data.page_token === page))
        throw new Error('周报字段分页失败');
      page = data.has_more ? data.page_token : undefined;
    } while (page);
    for (const name of Object.keys(desired))
      if (types.get(name) !== 1 && !(name === '链接' && types.get(name) === 15))
        throw new Error(`周报字段「${name}」类型不符`);
    const found = await this.record(id);
    const matches = (
      values: Record<string, string>,
      actual: Record<string, unknown>,
    ) =>
      Object.entries(values).every(([name, value]) =>
        name === '链接'
          ? documentUrl(actual[name]) === documentUrl(value) &&
            Boolean(documentUrl(value) || !this.text(value))
          : this.text(actual[name]) === this.text(value),
      );
    if (matches(desired, found)) return;
    if (!matches(expected, found))
      throw new Error('周报内容已被示例人员004修改，请重新打开核对');
    const fields: Record<string, unknown> = { ...desired };
    if ('链接' in fields && types.get('链接') === 15)
      fields['链接'] = { link: desired['链接'], text: '查看周报' };
    await this.request('PUT', `records/${id}`, { fields });
    if (!matches(desired, await this.record(id)))
      throw new Error('周报写入尚未确认，请重试回读');
    invalidateBitableRecordCache({
      appToken: WEEKLY_MEETING_SOURCE.appToken,
      tableId: WEEKLY_MEETING_SOURCE.tableId,
      deletePersisted: true,
    });
  }
  async people() {
    const appToken =
      process.env.FEISHU_ORG_APP_TOKEN ||
      process.env.FEISHU_ORGANIZATION_APP_TOKEN;
    if (!appToken) throw new Error('人员列表未配置');
    const records = await fetchBitableRecords(this.http, {
      appToken,
      tableId:
        process.env.FEISHU_ORG_TABLE_ID ||
        process.env.FEISHU_ORGANIZATION_TABLE_ID ||
        DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
      viewId:
        process.env.FEISHU_ORG_VIEW_ID || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
      tableName: '周会示例人员019员',
      automaticFields: true,
      strict: true,
      cacheTtlMs: 300000,
    });
    const now = Date.now();
    const directory = buildActivePersonnelDirectory({
      records,
      fetchedAt: now,
      expiresAt: now + 300000,
    } as Parameters<typeof buildActivePersonnelDirectory>[0]);
    return directory.personnel.map((person) => ({
      openId: person.openId,
      name: person.name,
      buildings: person.buildings,
      position: person.position,
      employeeNo: person.employeeNo,
    }));
  }
  async assertAttachmentField(field: string) {
    const fields: { field_name: string; type: number }[] = [];
    let page: string | undefined;
    do {
      const result = await this.request('GET', 'fields', undefined, {
        page_size: 100,
        ...(page ? { page_token: page } : {}),
      });
      if (!Array.isArray(result.items)) throw new Error('附件字段读取失败');
      fields.push(...result.items);
      if (result.has_more && (!result.page_token || result.page_token === page))
        throw new Error('附件字段分页失败');
      page = result.has_more ? result.page_token : undefined;
    } while (page);
    if (fields.find((item) => item.field_name === field)?.type !== 17)
      throw new Error(`请将「${field}」设置为附件字段`);
  }
  attachmentTokens(value: unknown): string[] {
    if (value == null) return [];
    if (
      !Array.isArray(value) ||
      value.some(
        (item) => typeof item?.file_token !== 'string' || !item.file_token,
      )
    )
      throw new Error('附件字段内容无效');
    return [...new Set(value.map((item) => item.file_token as string))].sort();
  }
  async uploadImage(
    buffer: Buffer,
    name: string,
    mime: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('file_name', name);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', WEEKLY_MEETING_SOURCE.appToken);
    form.append('size', String(buffer.length));
    form.append('file', buffer, { filename: name, contentType: mime });
    let access: string;
    try {
      access = await getTenantAccessToken(this.http);
    } catch {
      throw Object.assign(new Error('附件上传认证失败，请检查应用配置后重试'), {
        uploadRejected: true,
      });
    }
    const response = await this.http.axiosRef
      .post(
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
        form,
        {
          headers: { Authorization: `Bearer ${access}`, ...form.getHeaders() },
          timeout: 60000,
          maxBodyLength: 12 * 1024 * 1024,
        },
      )
      .catch((error: { response?: { status?: number } }) => {
        if (
          [400, 401, 403, 413, 415, 429].includes(error.response?.status || 0)
        )
          throw Object.assign(
            new Error('飞书拒绝附件上传，请检查权限、附件大小或稍后重试'),
            { uploadRejected: true },
          );
        throw error;
      });
    if (response.data?.code !== 0 || !response.data?.data?.file_token) {
      const error = new Error('飞书拒绝附件上传，请检查附件权限');
      Object.assign(error, { uploadRejected: true });
      throw error;
    }
    return response.data.data.file_token;
  }
  async appendImages(
    id: string,
    field: string,
    expected: string[],
    tokens: string[],
  ) {
    await this.assertAttachmentField(field);
    const desired = [...new Set([...expected, ...tokens])].sort();
    const actual = this.attachmentTokens((await this.record(id))[field]);
    if (JSON.stringify(actual) === JSON.stringify(desired)) return;
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
      throw new Error('会议附件已被示例人员004修改，请核对后重试');
    await this.request('PUT', `records/${id}`, {
      fields: { [field]: desired.map((file_token) => ({ file_token })) },
    });
    if (
      JSON.stringify(this.attachmentTokens((await this.record(id))[field])) !==
      JSON.stringify(desired)
    )
      throw new Error('附件写入尚未确认，请重试回读');
    invalidateBitableRecordCache({
      appToken: WEEKLY_MEETING_SOURCE.appToken,
      tableId: WEEKLY_MEETING_SOURCE.tableId,
      deletePersisted: true,
    });
  }
}
