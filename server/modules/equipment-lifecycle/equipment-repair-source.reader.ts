import type { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  getTenantAccessToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

export const EQUIPMENT_REPAIR_FIELDS = [
  '维修单号',
  '设备编号',
  '设备编号-L',
  '设备名称',
  '设备名称-L',
  '所属数据中心/楼栋-使用',
  '所属数据中心/楼栋-使用-L',
  '流程',
  '流程-L',
  '故障发生现象描述-L',
  '故障发生现象描述',
  '故障发生时间-L',
  '维修开始时间-L',
  '维修开始时间',
  '维修结束时间（2026）-L',
  '维修结束时间',
  '故障维修原因-L',
  '故障维修原因',
  '维修进展描述-L',
  '维修进展描述',
  '更换备件名称-L',
  '更换备件名称',
  '后续整改措施-L',
  '后续整改措施',
  '台账关联状态',
  '台账关联说明',
  '关联台账记录ID',
] as const;
const SOURCE =
  'https://open.feishu.cn/open-apis/base/v3/bases/RR4Sbm81xaII07sW0kacCb9xnih/tables/tblschT48zXwigUG';
const fingerprint = createHash('sha256')
  .update(JSON.stringify({ SOURCE, fields: EQUIPMENT_REPAIR_FIELDS }))
  .digest('hex');
const cachePath = () =>
  join(
    resolve(
      process.env.FEISHU_LOCAL_CACHE_DIR?.trim() ||
        join(process.cwd(), 'data', 'feishu-bitable-cache'),
    ),
    'equipment-history',
    'repair-v3.json',
  );
const checksum = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readPersistedRepairSnapshot(): Promise<{
  records: BitableRecordItem[];
  fetchedAt: number;
} | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const cached = JSON.parse(raw);
  if (
    cached.fingerprint !== fingerprint ||
    !Array.isArray(cached.records) ||
    !Number.isFinite(cached.fetchedAt) ||
    cached.fetchedAt > Date.now() ||
    cached.checksum !==
      checksum({
        fingerprint,
        fetchedAt: cached.fetchedAt,
        records: cached.records,
      })
  )
    throw new Error('维修缓存校验失败');
  return cached;
}
export async function persistRepairSnapshot(
  records: BitableRecordItem[],
  fetchedAt: number,
): Promise<void> {
  const value = { fingerprint, fetchedAt, records };
  const file = cachePath();
  await mkdir(join(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ ...value, checksum: checksum(value) }),
    'utf8',
  );
  await rename(temporary, file);
}

export async function fetchEquipmentRepairRecords(
  http: HttpService,
): Promise<BitableRecordItem[]> {
  const token = await getTenantAccessToken(http);
  const get = async (suffix: string, params: Record<string, unknown>) => {
    const response = await http.axiosRef.get(`${SOURCE}/${suffix}`, {
      params,
      paramsSerializer: { indexes: null },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    if (response.data?.code !== 0 || !response.data?.data)
      throw new Error('维修记录读取失败');
    return response.data.data;
  };
  const schema = await get('fields', { limit: 200, offset: 0 });
  if (schema.has_more || !Array.isArray(schema.fields))
    throw new Error('维修字段读取不完整');
  const fields = EQUIPMENT_REPAIR_FIELDS.map((name) => {
    const found = schema.fields.filter(
      (f: { name: string }) => f.name === name,
    );
    if (found.length !== 1) throw new Error('维修字段结构不匹配');
    return found[0].id as string;
  });
  const records: BitableRecordItem[] = [];
  const seen = new Set<string>();
  let rev: number | undefined;
  for (let offset = 0; ; offset += 200) {
    const page = await get('records', { field_id: fields, limit: 200, offset });
    if (
      !Array.isArray(page.fields) ||
      !Array.isArray(page.data) ||
      !Array.isArray(page.record_id_list) ||
      page.data.length !== page.record_id_list.length ||
      page.fields.length !== fields.length ||
      !EQUIPMENT_REPAIR_FIELDS.every((name) => page.fields.includes(name)) ||
      !Number.isSafeInteger(page.rev) ||
      (rev !== undefined && rev !== page.rev) ||
      (page.has_more && !page.data.length)
    )
      throw new Error('维修记录快照不完整或已变化');
    rev = page.rev;
    for (let i = 0; i < page.data.length; i++) {
      const id = page.record_id_list[i];
      if (!id || seen.has(id) || page.data[i].length !== page.fields.length)
        throw new Error('维修记录重复或结构异常');
      seen.add(id);
      records.push({
        record_id: id,
        fields: Object.fromEntries(
          page.fields.map((name: string, j: number) => [name, page.data[i][j]]),
        ),
      });
    }
    if (!page.has_more) break;
    if (offset >= 100000) throw new Error('维修记录超出读取范围');
  }
  return records;
}
