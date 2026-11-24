import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canPerformBusinessAction, type BusinessAction } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  FilePublicationGateway, type FilePublicationRecordColumn, type FilePublicationRecordSchema, type FilePublicationTableRecord,
} from './file-publication.gateway';
import { FilePublicationRecordsJournal, type TableMutationReceipt } from './file-publication-records-journal';
import { FilePublicationStore, publicationIdPattern } from './file-publication.store';

const MODULE = 'file_publication_table';
const markers = new Set(['发布批次ID', '文件发布批次ID', '发布批次编号']);
const editableTypes = new Set([1, 2, 3, 4, 5, 7, 13, 15]);
const recordIdPattern = /^rec[\w-]{1,120}$/u;
const versionPattern = /^[0-9a-f]{64}$/u;
const maxTextLength = 20_000;
const timeDisplay = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
type FieldValue = string | number | boolean | string[] | { text: string; link: string } | null;
type Values = Record<string, FieldValue>;
type WriteRequest = { link?: unknown; requestId?: unknown; version?: unknown; schemaVersion?: unknown; values?: unknown };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function can(principal: AccessPrincipal | undefined, action: BusinessAction): boolean {
  return !!principal && principal.role !== 'guest' && !principal.requiresPasswordChange &&
    canPerformBusinessAction(principal, { module: MODULE, action });
}

function requireAccess(principal: AccessPrincipal | undefined, action: BusinessAction): AccessPrincipal {
  if (!principal || !can(principal, 'read') || !can(principal, action)) {
    throw new ForbiddenException('当前账号无权操作文件发布多维表记录');
  }
  return principal;
}

function linkOf(link: unknown): string {
  if (typeof link !== 'string' || !link.trim() || link.length > 1_000) throw new BadRequestException('请粘贴飞书多维表链接');
  return link.trim();
}

function recordIdOf(id: string): string {
  if (!recordIdPattern.test(id)) throw new BadRequestException('多维表记录编号无效');
  return id;
}

function versionOf(version: unknown): string {
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new BadRequestException('数据版本无效，请刷新多维表');
  return version;
}

function isEditable(field: FilePublicationRecordColumn): boolean {
  return editableTypes.has(field.type) && !markers.has(field.name.trim()) &&
    ((field.type !== 3 && field.type !== 4) || (field.options?.length ?? 0) > 0);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function searchInput(input: unknown) {
  if (input === undefined) return undefined;
  const value = object(input);
  if (typeof value?.keyword !== 'string' || !value.keyword.trim() || value.keyword.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(value.keyword)) {
    throw new BadRequestException('请输入不超过 128 个字符的搜索关键词');
  }
  const { fieldKey } = value;
  if (fieldKey !== undefined && (typeof fieldKey !== 'string' || !/^fld[\w-]{1,100}$/u.test(fieldKey))) {
    throw new BadRequestException('请选择当前台账中可搜索的文本字段');
  }
  return { keyword: value.keyword.trim(), fieldKey };
}

function recordCursor(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input.trim() || input.length > 4_161 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new BadRequestException('多维表分页位置无效，请重新读取');
  }
  return input;
}

function schemaVersion(schema: FilePublicationRecordSchema): string {
  const fields = schema.fields.map(field => [field.key, field.name, field.type,
    field.options?.map(option => [option.id, option.name]).sort()] as const).sort(([a], [b]) => a.localeCompare(b));
  return digest([schema.appToken, schema.tableId, fields]);
}

function stableCell(value: unknown, type: number): unknown {
  if (Array.isArray(value)) return value.map(item => stableCell(item, type));
  const src = object(value);
  if (!src) return value ?? null;
  return Object.keys(src).sort().filter(key => !(type === 17 && ['url', 'tmp_url', 'temp_url'].includes(key)) && key !== 'avatar_url')
    .map(key => [key, stableCell(src[key], type)]);
}

function recordVersion(record: FilePublicationTableRecord, schema: FilePublicationRecordSchema, schemaId: string): string {
  return digest([schemaId, record.id, schema.fields.filter(field => field.type !== 19 && field.type !== 20).map(field => {
    const raw = record.fields[field.name];
    return [field.key, isEditable(field) && field.type !== 1 ? readValue(field, raw) : stableCell(raw, field.type)] as const;
  }).sort(([a], [b]) => a.localeCompare(b))]);
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : String(object(item)?.text ?? '')).join('');
}

function optionLabel(value: unknown, field: FilePublicationRecordColumn): string | null {
  const item = object(value);
  const label = typeof value === 'string' ? value : item?.name ?? item?.id;
  if (typeof label !== 'string') return null;
  return field.options?.find(option => option.id === label)?.name ?? label;
}

function webLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/u.test(raw) || raw.length > 2_048) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return raw;
  } catch {
    return null;
  }
}

function displayOnly(value: unknown, depth = 0): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (depth > 3) return '';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => displayOnly(item, depth + 1)).filter(Boolean).join('、');
  const data = object(value);
  if (!data) return '';
  if (Array.isArray(data.link_record_ids)) return `关联 ${data.link_record_ids.length} 条记录`;
  return displayOnly(data.name ?? data.text ?? data.text_arr ?? data.value ?? data.full_address ?? data.address, depth + 1);
}

function readValue(field: FilePublicationRecordColumn, raw: unknown): FieldValue {
  if (!isEditable(field)) {
    if ((field.type === 1001 || field.type === 1002) && typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= 8.64e15) {
      return timeDisplay.format(raw);
    }
    return displayOnly(raw).slice(0, 1_000) || null;
  }
  switch (field.type) {
    case 1:
    case 13:
      return plainText(raw) || null;
    case 2:
    case 5:
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 3:
      return optionLabel(raw, field) || null;
    case 4:
      return Array.isArray(raw) ? raw.map(item => optionLabel(item, field)).filter((item): item is string => !!item).sort() : [];
    case 7:
      return raw === true;
    case 15: {
      const data = object(raw);
      const link = webLink(data?.link ?? raw);
      return link ? { text: typeof data?.text === 'string' ? data.text : link, link } : null;
    }
    default:
      return null;
  }
}

function writeValue(field: FilePublicationRecordColumn, raw: unknown): FieldValue {
  const invalid = () => new BadRequestException(`字段「${field.name}」的值不符合类型或选项要求`);
  const options = new Set(field.options?.map(option => option.name));
  if (raw === null) return field.type === 7 ? false : field.type === 4 ? [] : null;
  switch (field.type) {
    case 1:
    case 13:
      if (typeof raw === 'string' && raw.length <= maxTextLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) return raw || null;
      break;
    case 2:
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      break;
    case 3:
      if (typeof raw === 'string' && options.has(raw)) return raw;
      break;
    case 4:
      if (Array.isArray(raw) && raw.length <= options.size && raw.every(value => typeof value === 'string' && options.has(value))) {
        return [...new Set(raw as string[])].sort();
      }
      break;
    case 5:
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && Math.abs(raw) <= 8.64e15) return raw;
      break;
    case 7:
      if (typeof raw === 'boolean') return raw;
      break;
    case 15: {
      const data = object(raw);
      const link = webLink(data?.link);
      if (link && typeof data?.text === 'string' && data.text.length <= 2_048) return { text: data.text || link, link };
      break;
    }
  }
  throw invalid();
}

function parseValues(values: unknown, schema: FilePublicationRecordSchema): Values {
  const entries = Object.entries(object(values) ?? {});
  if (!entries.length || entries.length > schema.fields.length) throw new BadRequestException('请选择要保存的字段');
  const columns = new Map(schema.fields.map(field => [field.key, field]));
  return Object.fromEntries(entries.map(([key, raw]) => {
    const field = columns.get(key);
    if (!field || !isEditable(field)) throw new BadRequestException('部分字段已变化或为只读，请刷新后重试');
    return [field.name, writeValue(field, raw)];
  }));
}

function valuesMatch(record: FilePublicationTableRecord, fields: Values, schema: FilePublicationRecordSchema): boolean {
  return schema.fields.every(field => !Object.hasOwn(fields, field.name) ||
    JSON.stringify(readValue(field, record.fields[field.name])) === JSON.stringify(fields[field.name]));
}

function richTextFields(record: FilePublicationTableRecord, schema: FilePublicationRecordSchema): FilePublicationRecordColumn[] {
  return schema.fields.filter(field => {
    if (field.type !== 1 || !isEditable(field)) return false;
    const raw = record.fields[field.name];
    if (!Array.isArray(raw)) return raw != null && typeof raw !== 'string';
    return raw.some(segment => {
      const part = object(segment);
      return typeof segment !== 'string' && (!part || (part.type !== undefined && part.type !== 'text') ||
        Object.keys(part).some(key => key !== 'type' && key !== 'text'));
    });
  });
}

function cloudFields(fields: Values): Values {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, Array.isArray(value) && !value.length ? null : value]));
}

function uncertain() {
  return new ServiceUnavailableException('飞书写入结果待核对，请保留当前内容并使用原请求重试');
}

function checkOriginalRejection(receipt: TableMutationReceipt | undefined): void {
  if (receipt?.rejection?.status === 400) throw new BadRequestException(receipt.rejection.message);
  if (receipt?.rejection?.status === 403) throw new ForbiddenException(receipt.rejection.message);
}

@Injectable()
export class FilePublicationRecordsService {
  private readonly journal = new FilePublicationRecordsJournal();
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly gateway: FilePublicationGateway, private readonly batches: FilePublicationStore) {}

  async query(principal: AccessPrincipal | undefined, body: { link?: unknown; pageToken?: unknown; search?: unknown }) {
    requireAccess(principal, 'read');
    const link = linkOf(body?.link);
    const encodedCursor = recordCursor(body?.pageToken);
    const requestedSearch = searchInput(body?.search);
    const schema = await this.gateway.getRecordSchema(link);
    const schemaId = schemaVersion(schema);
    const search = requestedSearch && {
      keyword: requestedSearch.keyword,
      fieldNames: schema.fields.filter(field => field.type === 1 &&
        (!requestedSearch.fieldKey || field.key === requestedSearch.fieldKey)).map(field => field.name).sort(),
    };
    if (search && !search.fieldNames.length) {
      throw new BadRequestException('请选择当前台账中可搜索的文本字段');
    }
    const cursorPrefix = search ? `${digest([schemaId, search])}:` : '';
    if (encodedCursor && search && (!encodedCursor.startsWith(cursorPrefix) || encodedCursor.length === cursorPrefix.length)) {
      throw new BadRequestException('搜索条件或台账字段已变化，请从第一页重新搜索');
    }
    const pageToken = encodedCursor?.slice(cursorPrefix.length);
    const [page, protectedRows] = await Promise.all([
      search ? this.gateway.listTableRecords(link, pageToken, schema, search) : this.gateway.listTableRecords(link, pageToken, schema),
      this.protection(schema),
    ]);
    return {
      tableName: schema.tableName, sourceUrl: schema.sourceUrl, schemaVersion: schemaId,
      pageToken: page.pageToken ? cursorPrefix + page.pageToken : undefined,
      ...(page.total !== undefined ? { total: page.total } : {}),
      fields: schema.fields.map(field => ({ ...field, editable: isEditable(field) })),
      records: page.records.map(record => this.present(record, schema, schemaId, this.isManaged(record, schema, protectedRows))),
      permissions: { create: can(principal, 'create'), update: can(principal, 'update'), delete: can(principal, 'delete') },
    };
  }

  async create(principal: AccessPrincipal | undefined, body: WriteRequest) {
    const actor = requireAccess(principal, 'create');
    const key = this.operationKey(actor, body?.requestId);
    const link = linkOf(body?.link);
    const expectedSchema = versionOf(body?.schemaVersion);
    return this.serialize(key, async () => {
      const schema = await this.gateway.getRecordSchema(link);
      if (schemaVersion(schema) !== expectedSchema) throw new ConflictException('多维表结构已变化，请刷新后重新填写');
      const fields = parseValues(body.values, schema);
      const fingerprint = digest(['create', expectedSchema, Object.entries(fields).sort()]);
      let receipt = await this.journal.read(key, fingerprint);
      checkOriginalRejection(receipt);
      const firstAttempt = !receipt;
      if (!receipt) {
        receipt = { fingerprint, startedAt: Date.now() };
        await this.journal.save(key, receipt);
      }
      if (!receipt.recordId) {
        // shortcut: 保守限制已丢失回执的飞书幂等重试，超过短窗口后需先人工核对。
        if (Date.now() - receipt.startedAt > 5 * 60_000) throw uncertain();
        const token = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
        try {
          const created = await this.gateway.createTableRecord(link, token, cloudFields(fields), schema);
          receipt.recordId = created.id;
        } catch (error) {
          return this.rejectWrite(key, receipt, firstAttempt, error);
        }
        await this.journal.save(key, receipt);
      }
      const record = await this.gateway.getTableRecord(link, receipt.recordId, schema).catch(() => { throw uncertain(); });
      if (!record) {
        if (receipt.completed) throw new ConflictException('该申请已创建过记录，但记录现已不存在，请刷新多维表');
        throw uncertain();
      }
      if (!receipt.completed && !valuesMatch(record, fields, schema)) throw uncertain();
      if (!receipt.completed) await this.journal.save(key, { ...receipt, completed: true });
      return { record: this.present(record, schema, expectedSchema, this.hasMarker(record, schema)) };
    });
  }

  async update(principal: AccessPrincipal | undefined, id: string, body: WriteRequest) {
    return this.change(requireAccess(principal, 'update'), 'update', recordIdOf(id), body);
  }

  async deleteRecord(principal: AccessPrincipal | undefined, id: string, body: WriteRequest) {
    return this.change(requireAccess(principal, 'delete'), 'delete', recordIdOf(id), body);
  }

  private async change(actor: AccessPrincipal, action: 'update' | 'delete', id: string, body: WriteRequest) {
    const key = this.operationKey(actor, body?.requestId);
    const link = linkOf(body?.link);
    const expected = versionOf(body?.version);
    return this.serialize(key, async () => {
      const schema = await this.gateway.getRecordSchema(link);
      const schemaId = schemaVersion(schema);
      const fields = action === 'update' ? parseValues(body.values, schema) : {};
      const fingerprint = digest([action, schemaId, id, expected, Object.entries(fields).sort()]);
      const lock = `row:${schema.appToken}:${schema.tableId}:${id}`;
      return this.serialize(lock, async () => {
        const receipt = await this.journal.read(key, fingerprint);
        checkOriginalRejection(receipt);
        const current = await this.gateway.getTableRecord(link, id, schema);
        const protectedRows = await this.protection(schema);
        if (protectedRows.ids.has(id) || protectedRows.unresolved || (current && this.hasMarker(current, schema))) {
          throw new ConflictException('该记录正在由文件发布流程维护，暂不可在此修改或删除');
        }
        if (!current && action === 'delete' && receipt) {
          if (!receipt.completed) await this.journal.save(key, { ...receipt, completed: true });
          return { deleted: true, id };
        }
        if (!current) throw new NotFoundException('该多维表记录已不存在，请刷新列表');
        if (receipt && action === 'update' && (receipt.completed || valuesMatch(current, fields, schema))) {
          if (!receipt.completed) await this.journal.save(key, { ...receipt, completed: true });
          return { record: this.present(current, schema, schemaId, false) };
        }
        if (receipt?.completed || recordVersion(current, schema, schemaId) !== expected) {
          throw new ConflictException('记录内容已变化，请刷新后核对');
        }
        if (richTextFields(current, schema).some(field => Object.hasOwn(fields, field.name))) {
          throw new BadRequestException('该字段包含富文本，请在飞书中编辑以保留链接和格式');
        }
        const intent = receipt ?? { fingerprint, startedAt: Date.now(), recordId: id };
        if (!receipt) await this.journal.save(key, intent);
        const write = action === 'delete'
          ? this.gateway.deleteTableRecord(link, id, schema)
          : this.gateway.updateTableRecord(link, id, cloudFields(fields), schema);
        const writeError = await write.then(() => undefined, (error: unknown) => error);
        const confirmed = await this.gateway.getTableRecord(link, id, schema).catch(() => { throw uncertain(); });
        if (action === 'delete') {
          if (confirmed) return this.rejectWrite(key, intent, !receipt, writeError);
          await this.journal.save(key, { ...intent, completed: true });
          return { deleted: true, id };
        }
        if (!confirmed || !valuesMatch(confirmed, fields, schema)) {
          return this.rejectWrite(key, intent, !receipt, writeError);
        }
        await this.journal.save(key, { ...intent, completed: true });
        return { record: this.present(confirmed, schema, schemaId, this.hasMarker(confirmed, schema)) };
      });
    });
  }

  private async rejectWrite(key: string, receipt: TableMutationReceipt, firstAttempt: boolean, error: unknown): Promise<never> {
    if (firstAttempt && (error instanceof BadRequestException || error instanceof ForbiddenException)) {
      const status = error instanceof BadRequestException ? 400 : 403;
      await this.journal.save(key, { ...receipt, rejection: { status, message: error.message } });
      throw error;
    }
    throw uncertain();
  }

  private async protection(schema: FilePublicationRecordSchema) {
    const relevant = (await this.batches.list()).filter(batch => batch.prepared
      ? batch.prepared.appToken === schema.appToken && batch.prepared.tableId === schema.tableId
      : batch.sourceUrl === schema.sourceUrl);
    const ids = new Set(relevant.flatMap(batch => batch.recordId ? [batch.recordId] : []));
    const markerNames = new Set(schema.fields.filter(field => field.type === 1 && markers.has(field.name.trim())).map(field => field.name));
    const unresolved = relevant.some(batch => batch.commitStartedAt !== undefined && !batch.recordId &&
      (!batch.prepared?.batchField || !markerNames.has(batch.prepared.batchField)));
    return { ids, unresolved };
  }

  private hasMarker(record: FilePublicationTableRecord, schema: FilePublicationRecordSchema): boolean {
    return schema.fields.some(field => {
      if (!markers.has(field.name.trim())) return false;
      const raw = record.fields[field.name];
      return raw != null && (typeof raw === 'string' ? !!raw.trim() : !Array.isArray(raw) || raw.length > 0);
    });
  }

  private isManaged(record: FilePublicationTableRecord, schema: FilePublicationRecordSchema, protectedRows: Awaited<ReturnType<FilePublicationRecordsService['protection']>>): boolean {
    return protectedRows.unresolved || protectedRows.ids.has(record.id) || this.hasMarker(record, schema);
  }

  private present(record: FilePublicationTableRecord, schema: FilePublicationRecordSchema, schemaId: string, managed: boolean) {
    const readonlyFields = richTextFields(record, schema).map(field => field.key);
    return { id: record.id, version: recordVersion(record, schema, schemaId), managed,
      ...(readonlyFields.length ? { readonlyFields } : {}),
      values: Object.fromEntries(schema.fields.map(field => [field.key, readValue(field, record.fields[field.name])])) };
  }

  private operationKey(actor: AccessPrincipal, requestId: unknown): string {
    const identity = actor.accountId ?? (actor.role === 'admin' ? 'legacy-admin' : undefined);
    if (!identity) throw new ForbiddenException('当前账号缺少可核对的操作身份');
    if (typeof requestId !== 'string' || !publicationIdPattern.test(requestId)) throw new BadRequestException('操作编号无效，请重新打开表单');
    return digest(['file-publication-record', identity, requestId]);
  }

  private async serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    const active = previous.catch(() => undefined).then(action);
    this.operations.set(key, active);
    try {
      return await active;
    } finally {
      if (this.operations.get(key) === active) this.operations.delete(key);
    }
  }
}
