import { resolvePersonnelLoginMethod } from '../../server/common/access/personnel-login-method';

describe('personnel login method from trusted directory fields', () => {
  it.each(['VNET', ' vnet ', '\tVnEt\n', { text: 'VNET' }, { name: ' VNET ' },
    { text: 'VNET', name: 'VNET' }, [{ text: 'VNET' }], [{ text: ' ' }, { text: 'VNET' }],
    [{ text: 'VNET' }, { text: 'VNET' }]])('recognizes one unambiguous VNET nature: %p', nature => {
    expect(resolvePersonnelLoginMethod({ 账号性质: nature })).toBe('feishu');
  });

  it.each(['外部账号', '驻场', '非VNET', 'external', { name: '合作人员' }, [{ text: '外部人员' }]])('classifies an explicit other nature as password: %p', nature => {
    expect(resolvePersonnelLoginMethod({ 账号性质: nature })).toBe('password');
  });

  it.each([undefined, null, '', '  ', [], {}, 1, true, { text: 2 }, { name: false },
    { text: 'VNET', name: '外部' }, [{ text: 'VNET' }, { text: '外部' }], ['VNET', '外部'],
    [{ text: '外部' }, { name: '合作' }], [{ text: 'VNET' }, null], [[{ text: 'VNET' }]],
    [{ text: 'V' }, { text: 'NET' }]])('does not guess missing, malformed or ambiguous nature: %p', nature => {
    expect(resolvePersonnelLoginMethod({ 账号性质: nature })).toBe('unknown');
  });

  it.each([null, undefined])('handles absent fields: %p', fields => {
    expect(resolvePersonnelLoginMethod(fields)).toBe('unknown');
  });

  it.each(['人员类型', '岗位'])('uses the exact trusted duty tag in %s without a name heuristic', key => {
    expect(resolvePersonnelLoginMethod({ [key]: '值班账号', 账号性质: '外部' })).toBe('feishu');
    expect(resolvePersonnelLoginMethod({ [key]: [{ text: ' 值班账号 ' }] })).toBe('feishu');
    expect(resolvePersonnelLoginMethod({ [key]: '值班账号管理员' })).toBe('unknown');
    expect(resolvePersonnelLoginMethod({ [key]: ['值班账号', '员工'], 账号性质: '外部' })).toBe('password');
  });

  it.each(['姓名', '员工工号', '邮箱', '体系岗位'])('does not infer login method from %s', key => {
    expect(resolvePersonnelLoginMethod({ [key]: 'VNET' })).toBe('unknown');
    expect(resolvePersonnelLoginMethod({ [key]: 'A楼值班账号', 账号性质: '外部' })).toBe('password');
  });

  it.each(['员工姓名', '员工', '人员'])('checks exact caller-trusted OpenIDs in linked field %s', key => {
    const trusted = new Set(['ou_duty_A']);
    for (const idKey of ['id', 'open_id', 'openId']) {
      const fields = { [key]: [{ [idKey]: 'ou_duty_A', name: '任意名称' }], 账号性质: '外部' };
      expect(resolvePersonnelLoginMethod(fields)).toBe('password');
      expect(resolvePersonnelLoginMethod(fields, trusted)).toBe('feishu');
    }
    expect(resolvePersonnelLoginMethod({ [key]: { id: 'ou_duty_A' } }, trusted)).toBe('feishu');
    expect(resolvePersonnelLoginMethod({ [key]: [{ id: 'ou_duty_a' }] }, trusted)).toBe('unknown');
  });

  it.each(['飞书 open_id', 'open_id', 'Open ID'])('checks exact caller-trusted explicit identity in %s', key => {
    const trusted = new Set(['ou_duty_110']);
    expect(resolvePersonnelLoginMethod({ [key]: [{ text: ' ou_duty_110 ' }] }, trusted)).toBe('feishu');
    expect(resolvePersonnelLoginMethod({ [key]: 'ou_duty_110' })).toBe('unknown');
    expect(resolvePersonnelLoginMethod({ [key]: ['ou_duty_110', 'ou_other'] }, trusted)).toBe('unknown');
    expect(resolvePersonnelLoginMethod({ [key]: 'not-an-open-id' }, new Set(['not-an-open-id']))).toBe('unknown');
  });

  it('preserves the caller inputs and does not grant authority', () => {
    const fields = Object.freeze({ 账号性质: '外部', 员工姓名: Object.freeze([{ id: 'ou_fixed' }]) });
    const trusted = new Set(['ou_fixed']);
    expect(resolvePersonnelLoginMethod(fields, trusted)).toBe('feishu');
    expect([...trusted]).toEqual(['ou_fixed']);
    expect(fields.账号性质).toBe('外部');
  });
});
