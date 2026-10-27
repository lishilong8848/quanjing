import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const script = resolve(
  process.cwd(),
  'scripts/migrate-leave-shift-substitute-details.mjs',
);

describe('migrate leave shift substitute details', () => {
  it('plans only uniquely resolvable rows and performs no data writes in dry-run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'leave-shift-migration-'));
    const logPath = join(directory, 'calls.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      writeFileSync(
        logPath,
        `${JSON.stringify({ method: request.method, path: url.pathname })}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      if (url.pathname === '/auth/v3/tenant_access_token/internal') {
        return send(response, { code: 0, tenant_access_token: 'tenant-token' });
      }
      if (
        url.pathname ===
        '/bitable/v1/apps/org-base/tables/tbl_personnel/records'
      ) {
        return send(response, {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_person_li',
                fields: { 姓名: '李四', open_id: 'ou_li' },
              },
              {
                record_id: 'rec_person_zhang_1',
                fields: { 姓名: '张三', open_id: 'ou_zhang_1' },
              },
              {
                record_id: 'rec_person_zhang_2',
                fields: { 姓名: '张三', open_id: 'ou_zhang_2' },
              },
            ],
            has_more: false,
          },
        });
      }
      if (url.pathname === '/bitable/v1/apps/test-base/tables') {
        return send(response, {
          code: 0,
          data: {
            items: [{ table_id: 'tbl_detail', name: '请假替班班次明细' }],
            has_more: false,
          },
        });
      }
      const leaveId = /\/tables\/tblpCzmTT3EapaUY\/records\/([^/]+)$/u.exec(
        url.pathname,
      )?.[1];
      if (leaveId) {
        const fieldsById: Record<string, Record<string, unknown>> = {
          rec_migratable: {
            系统影响排班记录ID: 'schedule_day、schedule_night',
            '替班人员（填姓名）': '李四',
          },
          rec_missing_impact: {
            '替班人员（填姓名）': '李四',
          },
          rec_ambiguous: {
            系统影响排班记录ID: 'schedule_day',
            '替班人员（填姓名）': '张三',
          },
          rec_unknown_shift: {
            系统影响排班记录ID: 'schedule_unknown',
            '替班人员（填姓名）': '李四',
          },
        };
        return send(response, {
          code: 0,
          data: { record: { record_id: leaveId, fields: fieldsById[leaveId] } },
        });
      }
      const scheduleId = /\/apps\/duty-base\/tables\/tbl_duty\/records\/([^/]+)$/u.exec(
        url.pathname,
      )?.[1];
      if (scheduleId) {
        const shiftById: Record<string, string> = {
          schedule_day: '白班',
          schedule_night: '夜班',
          schedule_unknown: '临时特殊班',
        };
        return send(response, {
          code: 0,
          data: {
            record: {
              record_id: scheduleId,
              fields: {
                排班日期: Date.parse('2026-08-26T00:00:00+08:00'),
                班次: shiftById[scheduleId],
              },
            },
          },
        });
      }
      response.statusCode = 404;
      return send(response, { code: 404, msg: 'unexpected request' });
    });

    try {
      await new Promise<void>((resolvePromise) =>
        server.listen(0, '127.0.0.1', resolvePromise),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('no address');
      const result = await runChild(
        process.execPath,
        [
          script,
          '--dry-run',
          '--record-id',
          'rec_migratable',
          '--record-id',
          'rec_missing_impact',
          '--record-id',
          'rec_ambiguous',
          '--record-id',
          'rec_unknown_shift',
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            LARK_OPENAPI_BASE_URL: `http://127.0.0.1:${address.port}`,
            FEISHU_APP_ID: 'test-app',
            FEISHU_APP_SECRET: 'test-secret',
            FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base',
            FEISHU_ORG_APP_TOKEN: 'org-base',
            FEISHU_SCHEDULE_APP_TOKEN: 'duty-base',
            FEISHU_SCHEDULE_TABLE_ID: 'tbl_duty',
            FEISHU_ACTIVE_PERSONNEL_TABLE_ID: 'tbl_personnel',
            FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: '',
          },
        },
      );

      if (result.status !== 0) {
        throw new Error(`migration child failed: ${result.stderr}`);
      }
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        mode: 'dry-run',
        writeEnabled: false,
        writes: [],
        plans: [
          {
            recordId: 'rec_migratable',
            disposition: 'migratable',
            groups: expect.arrayContaining([
              expect.objectContaining({ shift: '白班' }),
              expect.objectContaining({ shift: '夜班' }),
            ]),
            substitutePersonRecordId: 'rec_person_li',
          },
          {
            recordId: 'rec_missing_impact',
            disposition: 'manual-review',
            reason: 'missing-impact-schedule-ids',
          },
          {
            recordId: 'rec_ambiguous',
            disposition: 'manual-review',
            reason: 'ambiguous-substitute-person',
          },
          {
            recordId: 'rec_unknown_shift',
            disposition: 'manual-review',
            reason: 'unrecognized-shift',
          },
        ],
      });
      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        calls.filter(
          (call) =>
            call.path !== '/auth/v3/tenant_access_token/internal' &&
            ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method),
        ),
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function send(response: import('node:http').ServerResponse, payload: unknown) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function runChild(
  command: string,
  args: string[],
  options: { windowsHide: boolean; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', rejectPromise);
    child.once('exit', (status) => resolvePromise({ status, stdout, stderr }));
  });
}
