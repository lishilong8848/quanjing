import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
const cli = join(
  homedir(),
  'AppData/Local/Programs/nodejs/node_modules/@larksuite/cli/scripts/run.js',
);
const target = [
  '--base-token',
  'QmxAbhXNJaA9YKsbfZyclzhGnSd',
  '--table-id',
  'tblAoZ4ngXT22mVU',
];
const apply = process.argv.includes('--apply');
function call(command, args = []) {
  const result = spawnSync(
    process.execPath,
    [cli, 'base', command, ...target, ...args, '--as', 'user'],
    { encoding: 'utf8', timeout: 45000 },
  );
  if (result.status !== 0)
    throw new Error(`飞书字段命令 ${command} 失败；未输出认证内容`);
  const payload = JSON.parse(result.stdout);
  if ((payload.code && payload.code !== 0) || payload.error)
    throw new Error(`飞书字段命令 ${command} 返回错误`);
  return payload.data || payload;
}
export const definitions = [
  ...[
    '物品名称',
    '库存条目ID',
    '物品类别号',
    '型号规格',
    '品牌',
    '一级分类',
    '二级分类',
    '楼栋',
    '库房',
    '库位',
    '单位',
    '盘点月份',
    '确认人工号',
    '差异说明',
    '2026年10月',
  ].map((name) => ({ name, type: 'text', style: { type: 'plain' } })),
  ...['台账数量', '实盘数量', '差异数量'].map((name) => ({
    name,
    type: 'number',
    style: { type: 'plain', precision: 3 },
  })),
  ...['确认时间', '最近撤销时间'].map((name) => ({
    name,
    type: 'datetime',
    style: { format: 'yyyy-MM-dd HH:mm' },
  })),
  { name: '确认人', type: 'user', multiple: false },
  ...[
    ['盘点类型', ['重点抽盘', '库存核盘']],
    ['盘点状态', ['待盘', '已确认']],
    ['盘点结果', ['未确认', '账实一致', '盘盈', '盘亏']],
  ].map(([name, options]) => ({
    name,
    type: 'select',
    multiple: false,
    options: options.map((option) => ({
      name: option,
      hue:
        option === '盘亏'
          ? 'Red'
          : option === '盘盈'
            ? 'Orange'
            : option === '已确认' || option === '账实一致'
              ? 'Green'
              : 'Blue',
      lightness: 'Lighter',
    })),
  })),
];
const listed = call('+field-list');
const fields = listed.fields || listed.items || listed;
if (!Array.isArray(fields)) throw new Error('字段列表格式异常');
for (const definition of definitions) {
  const existing = fields.find((f) => f.name === definition.name);
  if (existing) {
    if (existing.type !== definition.type)
      throw new Error(`${definition.name} 类型不符；未自动转换`);
    continue;
  }
  const oldPrimary =
    definition.name === '物品名称' &&
    fields.find(
      (f) => f.name === '文本' && (f.id || f.field_id) === 'fldOmI6Ukl',
    );
  if (oldPrimary) {
    call('+field-get', ['--field-id', oldPrimary.id || oldPrimary.field_id]);
    if (oldPrimary.type !== 'text') throw new Error('主字段类型已改变');
  }
  if (apply)
    call(oldPrimary ? '+field-update' : '+field-create', [
      ...(oldPrimary
        ? ['--field-id', oldPrimary.id || oldPrimary.field_id, '--yes']
        : []),
      '--json',
      JSON.stringify(definition),
    ]);
  process.stdout.write(
    `${apply ? 'APPLIED' : 'PLAN'} ${definition.name} ${definition.type}\n`,
  );
}
process.stdout.write(`${apply ? 'SCHEMA_APPLIED' : 'SCHEMA_PLAN'}\n`);
