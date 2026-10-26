import type { HttpService } from '@nestjs/axios';
import type {
  MeetingDetail,
  MeetingSection,
} from '../../../shared/meeting-management.interface';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
import { documentUrl } from './meeting.mapper';

interface DocumentBlock {
  block_id: string;
  block_type: number;
  children?: string[];
  [key: string]: unknown;
}
const TITLES: Record<string, [string, string, boolean]> = {
  管理线: ['management', '管理线', false],
  专业线: ['professional', '专业线', false],
  运营线: ['operations', '运营线', false],
  本周待办: ['current-actions', '本周待办', true],
  待办事项: ['current-actions', '本周待办', true],
  阿里周会待办: ['customer-actions', '阿里会议待办', true],
  阿里会议待办: ['customer-actions', '阿里会议待办', true],
  上周内部周会待办: ['previous-actions', '上周周会待办', true],
  上周周会待办: ['previous-actions', '上周周会待办', true],
  上周遗留项: ['carryover', '上周遗留项', true],
};

export function documentSections(
  blocks: DocumentBlock[],
  id: string,
  names: Map<string, string> = new Map(),
): MeetingSection[] {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const ordered: DocumentBlock[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) throw new Error('周报文档层级重复');
    const block = byId.get(key);
    if (!block) throw new Error('周报文档内容不完整');
    seen.add(key);
    ordered.push(block);
    for (const child of block.children || []) visit(child);
  };
  visit(id);
  const sections = new Map<string, MeetingSection>();
  let current: MeetingSection | undefined;
  let currentHeadingLevel = 0;
  for (const block of ordered) {
    const key =
      block.block_type >= 3 && block.block_type <= 11
        ? `heading${block.block_type - 2}`
        : block.block_type === 12
          ? 'bullet'
          : block.block_type === 13
            ? 'ordered'
            : block.block_type === 17
              ? 'todo'
              : 'text';
    const body = block[key] as
      | {
          elements?: {
            text_run?: { content?: string };
            mention_user?: { user_name?: string; user_id?: string };
          }[];
          style?: { done?: boolean };
        }
      | undefined;
    const value =
      body?.elements
        ?.map(
          (element) =>
            element.text_run?.content ||
            (element.mention_user
              ? `@${element.mention_user.user_name || names.get(element.mention_user.user_id || '') || '已指定人员（见原文）'}`
              : ''),
        )
        .join('') || '';
    const title =
      TITLES[
        value
          .replace(/^\s*[一二三四五六七八九十\d]+[、.．）)]\s*/, '')
          .replace(/[\s：:]/g, '')
      ];
    if (key.startsWith('heading') && title) {
      currentHeadingLevel = block.block_type;
      current = sections.get(title[0]);
      if (!current) {
        current = {
          key: title[0],
          title: title[1],
          isAction: title[2],
          content: '',
          origin: 'document',
        };
        sections.set(current.key, current);
      }
    } else if (
      key.startsWith('heading') &&
      current &&
      block.block_type <= currentHeadingLevel
    ) {
      current = undefined;
    } else if (current && value.trim()) {
      const prefix =
        key === 'todo'
          ? body?.style?.done
            ? '☑ 已完成 · '
            : '☐ 待办 · '
          : key === 'bullet'
            ? '- '
            : key === 'ordered'
              ? '• '
              : '';
      current.content += `${current.content ? '\n' : ''}${prefix}${value}`;
    }
  }
  return [...sections.values()].filter((section) => section.content.trim());
}

interface DocumentRead {
  state: 'loading' | 'ready' | 'error';
  url: string | null;
  sections: MeetingSection[];
  expiresAt: number;
}
export class WeeklyDocumentReader {
  private readonly cache = new Map<string, DocumentRead>();
  constructor(
    private readonly http: HttpService,
    private readonly source: { appToken: string; tableId: string },
    private readonly people?: () => Promise<{ openId: string; name: string }[]>,
  ) {}
  get(meeting: MeetingDetail): DocumentRead {
    const key = `${meeting.id}:${meeting.updatedAt}:${meeting.documentUrl}`;
    const existing = this.cache.get(key);
    if (
      existing &&
      (existing.state === 'loading' || existing.expiresAt > Date.now())
    )
      return existing;
    if (this.cache.size >= 60) {
      for (const [oldKey, entry] of this.cache) {
        if (entry.state !== 'loading') this.cache.delete(oldKey);
        if (this.cache.size < 60) break;
      }
    }
    const entry: DocumentRead = {
      state: 'loading',
      url: meeting.documentUrl,
      sections: [],
      expiresAt: 0,
    };
    this.cache.set(key, entry);
    void this.load(meeting, entry)
      .then(() => {
        entry.state = 'ready';
        entry.expiresAt = Date.now() + 300000;
      })
      .catch(() => {
        entry.state = 'error';
        entry.expiresAt = Date.now() + 30000;
      });
    return entry;
  }
  private async load(meeting: MeetingDetail, entry: DocumentRead) {
    const deadline = Date.now() + 20000;
    const token = await getTenantAccessToken(this.http);
    const request = async (
      method: 'GET' | 'POST',
      path: string,
      data?: unknown,
      params?: Record<string, unknown>,
    ) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('原始周报读取超时');
      const response = await this.http.axiosRef.request({
        method,
        url: `https://open.feishu.cn/open-apis/${path}`,
        data,
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: Math.min(10000, remaining),
      });
      if (response.data?.code !== 0 || !response.data.data)
        throw new Error('原始周报不可读');
      return response.data.data;
    };
    if (!entry.url) {
      const data = await request(
        'POST',
        `base/v3/bases/${this.source.appToken}/tables/${this.source.tableId}/records/batch_get`,
        { record_id_list: [meeting.id] },
      );
      const index = data.record_id_list?.indexOf(meeting.id);
      const field = data.fields?.indexOf('链接');
      if (
        index === undefined ||
        index < 0 ||
        field === undefined ||
        field < 0 ||
        !Array.isArray(data.data?.[index])
      )
        throw new Error('原始周报链接回读失败');
      entry.url = documentUrl(data.data[index][field]);
    }
    const id = entry.url?.match(
      /^https:\/\/[^/]+\/docx\/([A-Za-z0-9]+)\/?(?:\?.*)?$/,
    )?.[1];
    if (!entry.url) return;
    if (!id) throw new Error('当前周报文档格式不支持');
    const blocks: DocumentBlock[] = [];
    let page: string | undefined;
    let revision: number | undefined;
    const visited = new Set<string>();
    do {
      const data = await request(
        'GET',
        `docx/v1/documents/${id}/blocks`,
        undefined,
        {
          page_size: 500,
          document_revision_id: revision ?? -1,
          ...(page ? { page_token: page } : {}),
        },
      );
      if (
        !Array.isArray(data.items) ||
        blocks.length + data.items.length > 20000
      )
        throw new Error('原始周报内容异常');
      if (
        revision !== undefined &&
        data.document_revision_id !== undefined &&
        revision !== data.document_revision_id
      )
        throw new Error('原始周报读取期间已修改');
      revision = data.document_revision_id ?? revision;
      blocks.push(...data.items);
      page = data.has_more ? data.page_token : undefined;
      if (data.has_more && (!page || visited.has(page)))
        throw new Error('原始周报分页失败');
      if (page) visited.add(page);
    } while (page);
    const names =
      this.people && blocks.some((block) => block.todo)
        ? new Map(
            (await this.people()).map((person) => [person.openId, person.name]),
          )
        : new Map<string, string>();
    entry.sections = documentSections(blocks, id, names);
  }
}
