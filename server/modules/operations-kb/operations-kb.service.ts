import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type OperationsKbAttachment = {
  name: string;
  url: string;
  type: string;
  isLocal: boolean;
};

export type OperationsKbMetaTag = {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'muted';
};

export type OperationsKbDocument = {
  id: string;
  title: string;
  recordUrl: string;
  rawFields: Record<string, string>;
  module: string;
  documentType: string;
  specialty: string;
  equipmentType: string;
  scenario: string;
  level: string;
  tags: string[];
  owner: string;
  updatedAt: string;
  sourceUrl: string;
  rawTable: string;
  rawRecordId: string;
  summary: string;
  excerpt: string;
  content: string;
  metaTags: OperationsKbMetaTag[];
  attachments: OperationsKbAttachment[];
};

export type OperationsKbSearchResponse = {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  facets: Record<string, Array<{ value: string; count: number }>>;
  results: Omit<OperationsKbDocument, 'content' | 'rawFields'>[];
};

const FACET_FIELDS = [
  'module',
  'documentType',
  'specialty',
  'equipmentType',
  'scenario',
  'level',
] as const;

const ROOT = process.cwd();
const KB_ROOT = path.join(ROOT, 'data', 'operations-kb', 'kb');
const RECORD_LINKS_PATH = path.join(ROOT, 'data', 'operations-kb', 'record-links.json');

@Injectable()
export class OperationsKbService {
  private cache: { docs: OperationsKbDocument[]; loadedAt: number } | null = null;
  private loading: Promise<OperationsKbDocument[]> | null = null;

  async stats() {
    const docs = await this.loadDocuments();
    const modules = new Set(docs.map((doc) => doc.module).filter(Boolean));
    const attachments = docs.reduce((total, doc) => total + doc.attachments.length, 0);
    const latestUpdatedAt = docs
      .map((doc) => doc.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    return {
      total: docs.length,
      modules: modules.size,
      attachments,
      latestUpdatedAt,
    };
  }

  async search(params: {
    query?: string;
    page?: number;
    pageSize?: number;
    sort?: 'relevance' | 'latest';
    filters?: Record<string, string | undefined>;
  }): Promise<OperationsKbSearchResponse> {
    const docs = await this.loadDocuments();
    const query = (params.query || '').trim();
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(50, Math.max(5, params.pageSize || 10));
    const filters = params.filters || {};
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

    const filtered = docs
      .filter((doc) => this.matchesFilters(doc, filters))
      .map((doc) => ({ doc, score: this.scoreDocument(doc, terms) }))
      .filter((item) => terms.length === 0 || item.score >= 10)
      .sort((a, b) => {
        if (params.sort === 'latest') {
          const dateCompare = (b.doc.updatedAt || '').localeCompare(a.doc.updatedAt || '');
          if (dateCompare !== 0) return dateCompare;
        }
        if (b.score !== a.score) return b.score - a.score;
        return (b.doc.updatedAt || '').localeCompare(a.doc.updatedAt || '');
      })
      .map((item) => item.doc);

    const start = (page - 1) * pageSize;
    const results = filtered.slice(start, start + pageSize).map(({ content, rawFields, ...doc }) => doc);

    return {
      query,
      total: filtered.length,
      page,
      pageSize,
      facets: this.buildFacets(filtered),
      results,
    };
  }

  async document(id: string) {
    const docs = await this.loadDocuments();
    return docs.find((doc) => doc.id === id || doc.rawRecordId === id) || null;
  }

  private async loadDocuments() {
    if (this.cache) return this.cache.docs;
    if (this.loading) return this.loading;

    this.loading = this.readDocuments().then((docs) => {
      this.cache = { docs, loadedAt: Date.now() };
      this.loading = null;
      return docs;
    });

    return this.loading;
  }

  private async readDocuments() {
    const files = await this.walkMarkdownFiles(KB_ROOT);
    const recordLinks = await this.readRecordLinks();
    const docs = await Promise.all(files.map((file) => this.readDocument(file, recordLinks)));
    return docs.filter((doc): doc is OperationsKbDocument => Boolean(doc));
  }

  private async readRecordLinks(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(RECORD_LINKS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && /^https?:\/\//i.test(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  private async walkMarkdownFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return this.walkMarkdownFiles(fullPath);
        if (entry.isFile() && entry.name.endsWith('.md')) return [fullPath];
        return [];
      }),
    );
    return nested.flat();
  }

  private async readDocument(filePath: string, recordLinks: Record<string, string>): Promise<OperationsKbDocument | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const { meta, body } = this.parseFrontMatter(raw);
      const rawFields = this.parseRawFieldTable(body);
      const parsedAttachments = this.parseAttachments(meta.attachments);
      const id = meta.id || path.basename(filePath, '.md');
      const title = this.pickDisplayTitle(meta, rawFields, parsedAttachments, filePath);
      const contentText = this.markdownToPlainText(body);
      const summary = meta.summary || this.makeDisplaySummary(rawFields, contentText);
      const fallbackRecordUrl = `/operations-kb/records/${encodeURIComponent(id)}`;
      const tableId = this.pickBitableTableId(parsedAttachments);
      const rawRecordId = meta.raw_record_id || id;
      const mappedRecordUrl = recordLinks[`${tableId}:${rawRecordId}`] || recordLinks[rawRecordId] || recordLinks[id] || '';
      const recordUrl = mappedRecordUrl || this.pickRecordUrl(meta, rawFields, parsedAttachments, id) || fallbackRecordUrl;

      return {
        id,
        title,
        recordUrl,
        rawFields,
        module: meta.module || meta.source_module || path.basename(path.dirname(filePath)),
        documentType: meta.document_type || meta.module || '',
        specialty: meta.specialty || '',
        equipmentType: meta.equipment_type || '',
        scenario: meta.scenario || '',
        level: meta.level || '',
        tags: this.splitList(meta.tags),
        owner: meta.owner || '',
        updatedAt: meta.updated_at || '',
        sourceUrl: meta.source_url || '',
        rawTable: meta.raw_table || '',
        rawRecordId,
        summary,
        excerpt: this.makeExcerpt(summary, summary),
        content: contentText,
        metaTags: this.buildMetaTags(rawFields, meta),
        attachments: this.pickDisplayAttachments(parsedAttachments, rawFields, recordUrl),
      };
    } catch {
      return null;
    }
  }

  private parseFrontMatter(raw: string) {
    if (!raw.startsWith('---')) {
      return { meta: {} as Record<string, string>, body: raw };
    }

    const end = raw.indexOf('\n---', 3);
    if (end === -1) {
      return { meta: {} as Record<string, string>, body: raw };
    }

    const block = raw.slice(3, end).trim();
    const body = raw.slice(end + 4).trim();
    const meta: Record<string, string> = {};

    block.split(/\r?\n/).forEach((line) => {
      const separator = line.indexOf(':');
      if (separator === -1) return;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      meta[key] = value;
    });

    return { meta, body };
  }

  private parseAttachments(value = ''): OperationsKbAttachment[] {
    return value
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [name = '', url = '', type = 'LINK'] = item.split('|');
        return {
          name: name.trim() || '附件',
          url: url.trim(),
          type: type.trim() || 'LINK',
          isLocal: !/^https?:\/\//i.test(url.trim()),
        };
      })
      .filter((item) => item.url);
  }

  private parseRawFieldTable(body: string) {
    const fields: Record<string, string> = {};
    body.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/);
      if (!match) return;
      const key = match[1].trim();
      const value = match[2].trim();
      if (!key || key === '字段' || key === '---') return;
      fields[key] = value;
    });
    return fields;
  }

  private pickDisplayTitle(
    meta: Record<string, string>,
    fields: Record<string, string>,
    attachments: OperationsKbAttachment[],
    filePath: string,
  ) {
    const deviceTitle = this.pickDeviceTitle(fields);
    const incidentTitle = this.pickIncidentTitle(fields);
    const fileField = fields['文件名'] || fields['文件'] || fields['知识库链接'] || fields['链接'] || meta.source_url;
    const fileAttachment = attachments.find((item) => this.isDownloadableAttachment(item));
    const source = fileField || deviceTitle || incidentTitle || fileAttachment?.name || meta.title || path.basename(filePath, '.md');
    return this.cleanTitle(source.replace(/\.(xlsx|xls|pdf|docx?|pptx?|csv|txt|zip)$/i, ''));
  }

  private pickRecordUrl(
    meta: Record<string, string>,
    fields: Record<string, string>,
    attachments: OperationsKbAttachment[],
    rawRecordId: string,
  ) {
    const candidates = [
      fields['记录链接'],
      fields['多维记录'],
      /^https?:\/\//i.test(fields['链接'] || '') ? fields['链接'] : '',
      meta.source_url,
      attachments.find((item) => item.name === '链接' && /^https?:\/\//i.test(item.url))?.url,
    ];
    const candidate = candidates.find((item) => item && /^https?:\/\//i.test(item) && !this.isOpenApiDownloadUrl(item)) || '';
    return this.withBitableRecordParams(candidate, attachments, rawRecordId);
  }

  private pickDisplayAttachments(attachments: OperationsKbAttachment[], fields: Record<string, string>, recordUrl: string) {
    const preferredFileName = fields['文件'] || fields['知识库链接'] || fields['文件名'] || '';
    const ignoredNames = new Set(['提交人', '新建/更新人员', '文件', '链接', '记录链接']);

    return attachments
      .filter((item) => this.isDownloadableAttachment(item))
      .map((item) => ({
        ...item,
        url: recordUrl || item.url,
        name: ignoredNames.has(item.name) && preferredFileName ? preferredFileName : item.name,
      }))
      .filter((item, index, list) => index === list.findIndex((next) => next.url === item.url && next.name === item.name));
  }

  private withBitableRecordParams(url: string, attachments: OperationsKbAttachment[], rawRecordId: string) {
    if (!url || !/^https?:\/\//i.test(url) || this.isOpenApiDownloadUrl(url)) return '';
    if (!rawRecordId) return url;

    const tableId = this.pickBitableTableId(attachments);
    if (!tableId) return url;

    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.get('table')) {
        parsed.searchParams.set('table', tableId);
      }
      if (!parsed.searchParams.get('record')) {
        parsed.searchParams.set('record', rawRecordId);
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private pickBitableTableId(attachments: OperationsKbAttachment[]) {
    for (const attachment of attachments) {
      try {
        const parsed = new URL(attachment.url);
        const extra = parsed.searchParams.get('extra');
        if (!extra) continue;
        const payload = JSON.parse(extra) as { bitablePerm?: { tableId?: string } };
        const tableId = payload.bitablePerm?.tableId;
        if (tableId) return tableId;
      } catch {
        continue;
      }
    }
    return '';
  }

  private isOpenApiDownloadUrl(url: string) {
    return /open-apis\/drive\/v1\/medias\/.+\/download/i.test(url) || /batch_get_tmp_download_url/i.test(url);
  }

  private isDownloadableAttachment(item: OperationsKbAttachment) {
    if (!item.url) return false;
    if (/batch_get_tmp_download_url/i.test(item.url)) return false;
    if (/static-resource\/v1/i.test(item.url)) return false;
    if (/\/download(\?|$)/i.test(item.url)) return true;
    return /\.(xlsx?|pdf|docx?|pptx?|csv|txt|zip)(\?|$)/i.test(item.name) || /\.(xlsx?|pdf|docx?|pptx?|csv|txt|zip)(\?|$)/i.test(item.url);
  }

  private makeDisplaySummary(fields: Record<string, string>, fallback: string) {
    const deviceParts = [
      fields['设备品牌'] ? `品牌 ${fields['设备品牌']}` : '',
      fields['设备类型'] ? `设备类型 ${fields['设备类型']}` : '',
      fields['设备型号'] ? `型号 ${fields['设备型号']}` : '',
      fields['设备分类'] ? `分类 ${fields['设备分类']}` : '',
    ].filter(Boolean);

    if (deviceParts.length) return deviceParts.join('，');

    const incidentParts = [
      fields['事件简述'] ? `事件 ${fields['事件简述']}` : '',
      fields['告警描述'] ? `告警 ${fields['告警描述']}` : '',
      fields['事件状态'] ? `状态 ${fields['事件状态']}` : '',
      fields['事件编号'] ? `编号 ${fields['事件编号']}` : '',
    ].filter(Boolean);

    if (incidentParts.length) return incidentParts.join('，');

    const parts = [
      fields['文件编号'] ? `文件编号 ${fields['文件编号']}` : '',
      fields['类型'] || fields['专业'] ? `类型 ${[fields['类型'], fields['专业']].filter(Boolean).join(' / ')}` : '',
      fields['版本号'] ? `版本 ${fields['版本号']}` : '',
      fields['文件状态'] ? `状态 ${fields['文件状态']}` : '',
      fields['备注'] ? `备注 ${fields['备注']}` : '',
    ].filter(Boolean);

    if (parts.length) return parts.join('，');
    return this.extractFirstUsefulLine(fallback);
  }

  private buildMetaTags(fields: Record<string, string>, meta: Record<string, string>): OperationsKbMetaTag[] {
    const tags: OperationsKbMetaTag[] = [];
    const push = (label: string, value?: string, tone?: OperationsKbMetaTag['tone']) => {
      const normalized = this.normalizeFieldValue(value);
      if (normalized) tags.push({ label, value: normalized, tone });
    };

    push('状态', fields['文件状态'], fields['文件状态'] === '在用' ? 'success' : fields['文件状态'] ? 'warning' : undefined);
    push('版本', fields['版本号']);
    push('更新人', fields['新建/更新人员'] || fields['更新人员'] || fields['修改人']);
    push('提交人', fields['提交人']);
    push('更新时间', fields['最新发布时间'] || fields['日期'] || meta.updated_at || meta.updatedAt, 'muted');
    push('文件编号', fields['文件编号'] || fields['编号']);
    push('品牌', fields['设备品牌']);
    push('型号', fields['设备型号']);
    push('事件状态', fields['事件状态']);
    push('事件编号', fields['事件编号']);

    return tags;
  }

  private normalizeFieldValue(value?: string) {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^\d{13}$/.test(trimmed)) {
      return new Date(Number(trimmed)).toISOString().slice(0, 10);
    }
    if (/^\d{10}$/.test(trimmed)) {
      return new Date(Number(trimmed) * 1000).toISOString().slice(0, 10);
    }
    return trimmed;
  }

  private splitList(value = '') {
    return value
      .split(/[,，、\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private markdownToPlainText(markdown: string) {
    return markdown
      .replace(/^#+\s+/gm, '')
      .replace(/^\|/gm, ' ')
      .replace(/\|/g, ' ')
      .replace(/`{1,3}/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractFirstUsefulLine(text: string) {
    return text
      .split(/\s{2,}|。/)
      .map((item) => item.trim())
      .find((item) => item.length > 8) || '';
  }

  private makeExcerpt(content: string, summary: string) {
    const source = summary || content;
    return source.length > 160 ? `${source.slice(0, 160)}...` : source;
  }

  private cleanTitle(title: string) {
    return title.trim();
  }

  private pickDeviceTitle(fields: Record<string, string>) {
    if (!fields['设备品牌'] && !fields['设备型号'] && !fields['设备类型']) return '';
    return [fields['设备品牌'], fields['设备类型'], fields['设备型号']]
      .filter(Boolean)
      .join(' - ');
  }

  private pickIncidentTitle(fields: Record<string, string>) {
    return fields['事件简述'] || fields['告警描述'] || '';
  }

  private matchesFilters(doc: OperationsKbDocument, filters: Record<string, string | undefined>) {
    return FACET_FIELDS.every((field) => {
      const selected = filters[field];
      if (!selected) return true;
      return doc[field] === selected;
    });
  }

  private scoreDocument(doc: OperationsKbDocument, terms: string[]) {
    if (terms.length === 0) return 1;
    if (doc.module === '查询检索') return 0;

    const searchable = {
      title: doc.title.toLowerCase(),
      module: doc.module.toLowerCase(),
      tags: doc.tags.join(' ').toLowerCase(),
      summary: doc.summary.toLowerCase(),
      focusedFields: this.focusedSearchText(doc.rawFields).toLowerCase(),
      attachments: doc.attachments.map((item) => item.name).join(' ').toLowerCase(),
    };

    return terms.reduce((score, term) => {
      let nextScore = score;
      if (searchable.title.includes(term)) nextScore += 80;
      if (searchable.module.includes(term)) nextScore += 35;
      if (searchable.tags.includes(term)) nextScore += 25;
      if (searchable.summary.includes(term)) nextScore += 18;
      if (searchable.focusedFields.includes(term)) nextScore += 14;
      if (searchable.attachments.includes(term)) nextScore += 16;
      return nextScore;
    }, 0);
  }

  private focusedSearchText(fields: Record<string, string>) {
    const meaningfulKeys = [
      '文件',
      '文件名',
      '文件编号',
      '文件状态',
      '专业',
      '类型',
      '设备品牌',
      '设备型号',
      '设备类型',
      '设备分类',
      '事件简述',
      '告警描述',
      '事件解决措施',
      '事件状态',
      '事件编号',
      '知识库链接',
      '链接',
      '备注',
    ];

    return meaningfulKeys.map((key) => fields[key]).filter(Boolean).join(' ');
  }

  private buildFacets(docs: OperationsKbDocument[]) {
    return FACET_FIELDS.reduce<Record<string, Array<{ value: string; count: number }>>>((acc, field) => {
      const counts = new Map<string, number>();
      docs.forEach((doc) => {
        const value = doc[field];
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
      });
      acc[field] = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))
        .slice(0, 24);
      return acc;
    }, {});
  }
}
