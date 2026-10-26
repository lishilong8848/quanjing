import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { convertElectricalWorkbook } from './import-electrical-thresholds.mjs';

test('共用变压器参数仅按已确认的楼栋扩展，原值和代码不丢失', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['变压器'],
    ['', '风机启停目标值', 'OB', 90],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, '变压器');
  const unconfirmed = convertElectricalWorkbook(book);
  assert.equal(unconfirmed.records[0].building, '');
  const confirmed = convertElectricalWorkbook(book, {
    transformerSharedBuildings: ['A楼', 'B楼', 'C楼'],
  });
  assert.deepEqual(
    confirmed.records.map((r) => [
      r.building,
      r.value,
      r.note,
      r.source.noteCell,
    ]),
    [
      ['A楼', '90', 'OB', 'C2'],
      ['B楼', '90', 'OB', 'C2'],
      ['C楼', '90', 'OB', 'C2'],
    ],
  );
  assert.equal(new Set(confirmed.records.map((r) => r.id)).size, 3);
});

test('参数缩写、表外旁注和合并设备类别完整保留', () => {
  const book = XLSX.utils.book_new();
  const add = (name, cells, ref, merges = []) => {
    const sheet = {
      '!ref': ref,
      '!merges': merges.map(XLSX.utils.decode_range),
    };
    for (const [cell, value] of Object.entries(cells))
      sheet[cell] = { t: 's', v: value };
    XLSX.utils.book_append_sheet(book, sheet, name);
  };
  add(
    '中压逻辑时间',
    {
      A1: '逻辑时间',
      B2: 'PLC',
      F2: '综保',
      A4: '自投延时',
      B3: 'A-120',
      F3: 'C-120',
      B4: '5S',
      F4: '5.5S',
    },
    'A1:K4',
    ['B2:E2', 'F2:K2'],
  );
  add(
    '燃油控制系统',
    { A1: '楼栋', C1: 'A楼', A3: '上限报警值', B3: 'AH', C3: '80' },
    'A1:G3',
  );
  add('变压器', { B2: '风机启停目标值', C2: 'OB', D2: '90' }, 'A1:L2');
  add(
    '直流列头柜',
    {
      B1: '楼栋',
      C1: 'A楼',
      K1: 'E楼',
      B110: '使能4-12',
      K110: '65535',
      M110: '使能4',
      N110: '15',
      O110: '使能5',
    },
    'A1:P110',
  );
  const rows = convertElectricalWorkbook(book).records;
  assert.equal(
    rows.find((r) => r.device === '中压逻辑时间' && r.source.cell === 'B4')
      .section,
    'PLC',
  );
  assert.equal(
    rows.find((r) => r.device === '中压逻辑时间' && r.source.cell === 'F4')
      .section,
    '综保',
  );
  assert.equal(
    rows.find((r) => r.device === '燃油控制系统' && r.source.cell === 'C3')
      .note,
    'AH',
  );
  assert.equal(
    rows.find((r) => r.device === '变压器' && r.source.cell === 'D2').note,
    '原表未标明楼栋\nOB',
  );
  const side = rows.find(
    (r) => r.device === '直流列头柜' && r.source.cell === 'K110',
  );
  assert.equal(side.note, '使能4\n15\n使能5');
  assert.equal(side.source.noteCell, 'M110,N110,O110');
  assert.equal(
    rows.find((r) => r.device === '直流列头柜' && r.source.cell === 'C110')
      .note,
    '',
  );
});

test('全空设定值仍是参数，不覆盖合并分组或改变告警使能列', () => {
  const book = XLSX.utils.book_new();
  const hvdc = XLSX.utils.aoa_to_sheet([
    ['HVDC'],
    ['楼栋', '', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼'],
    ['时间设置', '时间与北京时间同步'],
    ['通讯设置', '串口通讯'],
    ['', '通讯地址'],
    ['', '通讯协议', 'MODBUS-RTU'],
  ]);
  hvdc['!merges'] = [XLSX.utils.decode_range('A4:A6')];
  XLSX.utils.book_append_sheet(book, hvdc, 'HVDC');
  const rail = XLSX.utils.aoa_to_sheet([
    ['', '楼栋', 'A楼'],
    ['', '参数', '告警使能', '设定值'],
    ['', '空白告警'],
    ['', '有值告警', 'YES', 240],
  ]);
  XLSX.utils.book_append_sheet(book, rail, '交流列头柜');
  const records = convertElectricalWorkbook(book).records;
  const address = records.filter((r) => r.parameter === '通讯地址');
  assert.equal(address.length, 5);
  assert(address.every((r) => r.value === '' && r.section === '通讯设置'));
  assert.equal(
    records.find((r) => r.source.sheet === 'HVDC' && r.source.cell === 'C6')
      .section,
    '通讯设置',
  );
  assert.equal(
    records.find((r) => r.source.sheet === 'HVDC' && r.source.cell === 'C3')
      .parameter,
    '时间与北京时间同步',
  );
  assert.equal(
    records.find(
      (r) => r.source.sheet === '交流列头柜' && r.source.cell === 'D4',
    ).value,
    '240',
  );
  assert.equal(
    records.find(
      (r) => r.source.sheet === '交流列头柜' && r.source.cell === 'D3',
    ).value,
    '',
  );
});

test('直流屏品牌和硅链档位保留，横向合并标签不能错作分组', () => {
  const book = XLSX.utils.book_new();
  const sheet = {
    '!ref': 'A1:Z6',
    '!merges': ['O4:P4', 'O5:P5', 'O6:O8'].map(XLSX.utils.decode_range),
  };
  for (const [address, value] of Object.entries({
    B3: 'A-120直流屏',
    A4: '品牌',
    B4: '五三通',
    A5: '硅链档位',
    B5: '自动',
    A6: '模块类型',
    B6: '110V10A',
    Q3: 'D-144直流屏',
    O4: '品牌',
    Q4: '赛迪生',
    O5: '硅链档位',
    Q5: '自动',
    O6: '维护配置',
    P6: '系统类型',
    Q6: '110V',
  }))
    sheet[address] = { t: 's', v: value };
  XLSX.utils.book_append_sheet(book, sheet, '直流屏');
  const records = convertElectricalWorkbook(book).records;
  assert.equal(records.find((r) => r.source.cell === 'B4')?.parameter, '品牌');
  assert.equal(
    records.find((r) => r.source.cell === 'B5')?.parameter,
    '硅链档位',
  );
  assert.equal(records.find((r) => r.source.cell === 'Q4')?.parameter, '品牌');
  assert.equal(
    records.find((r) => r.source.cell === 'Q5')?.parameter,
    '硅链档位',
  );
  assert.equal(
    records.find((r) => r.source.cell === 'Q6')?.section,
    '维护配置',
  );
});
test('变压器、SVG 和列头柜使用绝对列，并区分告警使能与数值', () => {
  const book = XLSX.utils.book_new();
  const add = (name, cells, ref) => {
    const sheet = { '!ref': ref };
    for (const [key, value] of Object.entries(cells))
      sheet[key] = { t: typeof value === 'number' ? 'n' : 's', v: value };
    XLSX.utils.book_append_sheet(book, sheet, name);
  };
  add(
    '变压器',
    {
      B2: '风机启停目标值',
      D2: 90,
      G2: '风机启动',
      H2: 80,
      K2: '风机启动',
      L2: 80,
    },
    'B1:L4',
  );
  add(
    'SVG',
    {
      B1: '楼栋',
      C1: 'A楼',
      B3: 'CT变比',
      C3: 1000,
      H3: 'CT变比',
      I3: 1000,
      M3: '目标功因',
      N3: 0.96,
    },
    'B1:N3',
  );
  add(
    '交流列头柜',
    {
      B1: '楼栋',
      C1: 'A楼',
      B2: '额定电流（A）',
      C2: 630,
      B3: '参数',
      C3: '告警使能',
      D3: '设定值',
      B4: '电压上限',
      C4: 'YES',
      D4: 240,
    },
    'B1:J4',
  );
  const records = convertElectricalWorkbook(book).records;
  assert.equal(
    records.find((r) => r.source.sheet === '变压器' && r.source.cell === 'D2')
      .value,
    '90',
  );
  assert.equal(
    records.find((r) => r.source.sheet === '变压器' && r.source.cell === 'H2')
      .building,
    'D楼',
  );
  assert.equal(
    records.find((r) => r.source.sheet === 'SVG' && r.source.cell === 'C3')
      .parameter,
    'CT变比',
  );
  assert.equal(
    records.find((r) => r.source.sheet === 'SVG' && r.source.cell === 'N3')
      .value,
    '0.96',
  );
  assert.equal(
    records.find(
      (r) => r.source.sheet === '交流列头柜' && r.source.cell === 'D4',
    ).enabled,
    'YES',
  );
  assert.equal(
    records.find(
      (r) => r.source.sheet === '交流列头柜' && r.source.cell === 'D4',
    ).value,
    '240',
  );
});
test('工作表从 B 列开始时仍按真实单元格坐标读取参数和楼栋', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(
    [
      ['电气关键设备参数表'],
      ['中压柜开关额定电流'],
      ['开关名称', 'A', 'B', 'C', 'D', 'E'],
      ['市电进线柜', 1250, 1250, 1250, 1250, 1250],
    ],
    { origin: 'B1' },
  );
  sheet['!ref'] = 'B1:G4';
  XLSX.utils.book_append_sheet(book, sheet, '电气关键设备参数表');
  const output = convertElectricalWorkbook(book);
  assert.equal(output.records[0].parameter, '市电进线柜');
  assert.equal(output.records[0].building, 'A楼');
  assert.equal(output.records[0].source.cell, 'C4');
  assert.equal(output.records[0].value, '1250');
});
test('保留百分比、零值、空白、复合值及设备网络参数；只排除凭证', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['中压逻辑时间设定值'],
    ['设备', 'PLC', '', '', '', '综保'],
    [
      '参数位置',
      'A-120',
      'A-144',
      'B-144',
      'B-120',
      'C-120',
      'C-144',
      'D-120',
      '',
      '',
      '',
    ],
    [
      '自投延时',
      0,
      '5S',
      '5S',
      '5S',
      '5.5S',
      '5.5S',
      '5.5S',
      '5.5S',
      '5.5S',
      '5.5S',
    ],
    ['自复延时', '180S', '', '180S', '180S', '单路180S\n双路600S'],
    ['密码', 'test-sensitive-value'],
    ['IP地址', '192.0.2.010'],
    ['网关', '192.0.2.001'],
    ['子网掩码', '255.255.255.0'],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, '中压逻辑时间');
  const output = convertElectricalWorkbook(book);
  assert.equal(output.records.find((r) => r.source.cell === 'B4').value, '0');
  assert.equal(output.records.find((r) => r.source.cell === 'C5').value, '');
  assert.equal(output.records.find((r) => r.source.cell === 'I4').building, '');
  assert.match(
    output.records.find((r) => r.source.cell === 'I4').location,
    /原表/,
  );
  assert.match(output.records.find((r) => r.source.cell === 'F5').value, /\n/);
  assert.doesNotMatch(JSON.stringify(output), /test-sensitive-value/);
  assert.equal(
    output.records.find((r) => r.source.cell === 'B7')?.value,
    '192.0.2.010',
  );
  assert.equal(
    output.records.find((r) => r.source.cell === 'B8')?.value,
    '192.0.2.001',
  );
  assert.equal(
    output.records.find((r) => r.source.cell === 'B9')?.value,
    '255.255.255.0',
  );
});
test('UPS 百分比依据单元格格式，原始文本和空格保留', () => {
  const book = XLSX.utils.book_new();
  const rows = [
    ['', '300K UPS'],
    ['', '楼栋', '', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼'],
    ['', '旁路设定', '电压范围', 0.15, 0.15, 0.15, 0.15, 0.15],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet.D3.z = '0%';
  XLSX.utils.book_append_sheet(book, sheet, 'UPS');
  assert.equal(
    convertElectricalWorkbook(book).records.find((r) => r.source.cell === 'D3')
      .value,
    '15%',
  );
});
