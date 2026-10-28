import { scrypt } from 'node:crypto';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
jest.mock('node:crypto', () => ({ ...jest.requireActual('node:crypto'), scrypt: jest.fn() }));

it('derives at most two passwords at once and preserves record order, salts and output encoding', async () => {
  const prior = process.env.LOCAL_ACCESS_SESSION_SECRET;
  process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 9).toString('base64');
  const pending: (() => void)[] = [];
  let active = 0, peak = 0;
  (scrypt as unknown as jest.Mock).mockImplementation((_password, salt, bytes, callback) => {
    active++; peak = Math.max(peak, active);
    expect(Buffer.isBuffer(salt)).toBe(true); expect(salt).toHaveLength(16); expect(bytes).toBe(32);
    pending.push(() => { active--; callback(null, Buffer.alloc(32, 7)); });
  });
  try {
    const result = buildExternalEmployeeCredentials([0, 1, 2, 3, 4].map(i => ({ record_id: `recSynthetic${i}`, fields: { 姓名: `合成人员${i}`, 密码: `synthetic-password-${i}` } })), 'cli_synthetic', 'syntheticBase', 'tblSynthetic');
    expect(active).toBe(2);
    while (pending.length) { pending.shift()!(); await Promise.resolve(); }
    const people = await result;
    expect(peak).toBe(2); expect(active).toBe(0);
    expect(people.map(person => person.name)).toEqual([0, 1, 2, 3, 4].map(i => `合成人员${i}`));
    expect(people.every(person => /^scrypt\$[^$]+\$[^$]+$/.test(person.passwordHash || ''))).toBe(true);
    expect(scrypt).toHaveBeenCalledTimes(5);
  } finally {
    if (prior === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET; else process.env.LOCAL_ACCESS_SESSION_SECRET = prior;
    jest.clearAllMocks();
  }
});
