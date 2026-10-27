import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as directory from '../../server/modules/bitable-sync/change-request-submitter-directory';

describe('change request search and direct entry', () => {
  it('provides stable public person IDs without exposing Feishu accounts', () => {
    expect(directory).toHaveProperty('listChangeRequestSubmitters');
    const list = directory.listChangeRequestSubmitters;
    const records = [
      {
        record_id: 'rec1',
        fields: { 姓名: '张三', 员工姓名: [{ id: 'ou_test', name: '张三' }] },
      },
    ];
    const options = list(records);
    expect(options).toEqual([
      { id: expect.stringMatching(/^cr-person-[a-f0-9]{64}$/), name: '张三' },
    ]);
    expect(JSON.stringify(options)).not.toContain('ou_test');
    expect(list([{ ...records[0], record_id: 'rec2' }])).toEqual(options);
    const resolve = directory.resolveChangeRequestSubmitterCandidate as (
      ...args: unknown[]
    ) => unknown;
    expect(resolve(records, '张三', options[0].id)).toEqual({
      ok: true,
      userId: 'ou_test',
    });
    expect(resolve(records, '张三', 'cr-person-wrong')).toEqual({
      ok: false,
      reason: 'identity-mismatch',
    });
  });

  it('returns no initial list and caps matching results for a large directory', () => {
    const path = join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/change-request-people.ts',
    );
    expect(existsSync(path)).toBe(true);
    const { searchChangeRequestPeople } = jest.requireActual(path);
    const people = Array.from({ length: 10000 }, (_, i) => ({
      id: `p${i}`,
      name: `张三${i}`,
    }));
    expect(searchChangeRequestPeople(people, '')).toEqual([]);
    expect(searchChangeRequestPeople(people, '   ')).toEqual([]);
    expect(searchChangeRequestPeople(people, '张')).toHaveLength(20);
    expect(searchChangeRequestPeople(people, '张 三9999')).toEqual([
      people[9999],
    ]);
    expect(searchChangeRequestPeople(people, '不存在')).toEqual([]);
  });

  it('dispatches only the exact change application URL into the independent page', () => {
    const path = join(
      process.cwd(),
      'client/src/navigation/change-request-route.ts',
    );
    expect(existsSync(path)).toBe(true);
    const { isChangeRequestDirectPath, CHANGE_REQUEST_DIRECT_PATH } =
      jest.requireActual(path);
    expect(CHANGE_REQUEST_DIRECT_PATH).toBe('/monthly-schedule/apply/change');
    expect(isChangeRequestDirectPath('/Monthly-Schedule/apply/change///')).toBe(
      true,
    );
    expect(
      isChangeRequestDirectPath('/monthly-schedule/apply/change-extra'),
    ).toBe(false);
    expect(isChangeRequestDirectPath('/monthly-schedule')).toBe(false);
    const source = readFileSync(
      join(process.cwd(), 'client/src/index.tsx'),
      'utf8',
    );
    expect(source).toContain("import('./pages/ChangeRequestApply')");
    expect(source).not.toContain("import RoutesComponent from './app.tsx'");
  });
});
