import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  archiveBackfillWithCorrectionApprovals,
  buildCorrectionApprovalQuery,
  parseBackfillOptions,
} from '../../scripts/backfill-dingtalk-attendance-archive.mjs';

test('passes deduplicated in-scope correction approvals to the archive gateway', async () => {
  const correctionQuery = {
    start: '2026-09-04 00:00:00',
    end: '2026-09-15 23:59:59',
  };
  const first = {
    processInstanceId: 'process-1',
    workDate: Date.parse('2026-09-04T00:00:00+08:00'),
    correctionTime: Date.parse('2026-09-04T18:00:00+08:00'),
    reason: 'first payload',
  };
  const replacement = { ...first, reason: 'latest payload' };
  const outside = {
    ...first,
    processInstanceId: 'process-2',
    workDate: Date.parse('2026-09-05T00:00:00+08:00'),
  };
  const correctionQueries = [];
  const archiveInputs = [];
  const correctionInputs = [];

  const result = await archiveBackfillWithCorrectionApprovals({
    dates: ['2026-09-04'],
    correctionQuery,
    dingTalkClient: {
      async listCorrectionApprovals(query) {
        correctionQueries.push(query);
        return [first, replacement, outside];
      },
    },
    gateway: {
      async archiveAttendance(input) {
        archiveInputs.push(input);
        return { total: 2, created: 1, updated: 1 };
      },
    },
    async buildArchiveInput(date, corrections) {
      correctionInputs.push(corrections);
      return {
        input: {
          businessDate: date,
          users: [],
          results: [],
          details: [],
        },
        audit: { date, expected: 1, detailRecords: 0 },
      };
    },
  });

  assert.deepEqual(correctionQueries, [correctionQuery]);
  assert.deepEqual(correctionInputs, [[replacement]]);
  assert.equal(archiveInputs.length, 1);
  assert.deepEqual(archiveInputs[0].corrections, [replacement]);
  assert.deepEqual(result.correctionApprovals, {
    query: correctionQuery,
    fetched: 3,
    unique: 2,
    duplicates: 1,
    inScope: 1,
    outOfScope: 1,
    byDate: [{ date: '2026-09-04', count: 1 }],
  });
  assert.deepEqual(result.archived, [
    {
      date: '2026-09-04',
      expected: 1,
      detailRecords: 0,
      correctionApprovals: 1,
      total: 2,
      created: 1,
      updated: 1,
    },
  ]);
});

test('rejects an oversized correction query before calling DingTalk', async () => {
  let correctionCalls = 0;
  let archiveCalls = 0;

  await assert.rejects(
    archiveBackfillWithCorrectionApprovals({
      dates: ['2026-09-04'],
      correctionQuery: {
        start: '2026-08-01 00:00:00',
        end: '2026-09-15 23:59:59',
      },
      dingTalkClient: {
        async listCorrectionApprovals() {
          correctionCalls += 1;
          return [];
        },
      },
      gateway: {
        async archiveAttendance() {
          archiveCalls += 1;
          return { total: 0, created: 0, updated: 0 };
        },
      },
      async buildArchiveInput(date) {
        return {
          input: { businessDate: date, users: [], results: [], details: [] },
          audit: { date, expected: 1, detailRecords: 0 },
        };
      },
    }),
    /补卡审批查询区间不能超过 31 天/u,
  );

  assert.equal(correctionCalls, 0);
  assert.equal(archiveCalls, 0);
});

test('rejects too many correction approvals before writing Feishu', async () => {
  let archiveCalls = 0;
  const corrections = Array.from({ length: 20 }, (_, index) => ({
    processInstanceId: `process-${index + 1}`,
    workDate: Date.parse('2026-09-04T00:00:00+08:00'),
  }));

  await assert.rejects(
    archiveBackfillWithCorrectionApprovals({
      dates: ['2026-09-04'],
      correctionQuery: {
        start: '2026-09-04 00:00:00',
        end: '2026-09-15 23:59:59',
      },
      dingTalkClient: {
        async listCorrectionApprovals() {
          return corrections;
        },
      },
      gateway: {
        async archiveAttendance() {
          archiveCalls += 1;
          return { total: 0, created: 0, updated: 0 };
        },
      },
      async buildArchiveInput(date) {
        return {
          input: { businessDate: date, users: [], results: [], details: [] },
          audit: { date, expected: 1, detailRecords: 0 },
        };
      },
    }),
    /补卡审批实例 20 条，超过单次安全上限 19 条/u,
  );

  assert.equal(archiveCalls, 0);
});

test('rejects correction approvals without processInstanceId before writing Feishu', async () => {
  let archiveCalls = 0;

  await assert.rejects(
    archiveBackfillWithCorrectionApprovals({
      dates: ['2026-09-04'],
      correctionQuery: {
        start: '2026-09-04 00:00:00',
        end: '2026-09-15 23:59:59',
      },
      dingTalkClient: {
        async listCorrectionApprovals() {
          return [
            {
              processInstanceId: '',
              workDate: Date.parse('2026-09-04T00:00:00+08:00'),
            },
          ];
        },
      },
      gateway: {
        async archiveAttendance() {
          archiveCalls += 1;
          return { total: 0, created: 0, updated: 0 };
        },
      },
      async buildArchiveInput(date) {
        return {
          input: { businessDate: date, users: [], results: [], details: [] },
          audit: { date, expected: 1, detailRecords: 0 },
        };
      },
    }),
    /补卡审批列表返回 1 条缺少 processInstanceId 的记录；尚未写入飞书/u,
  );

  assert.equal(archiveCalls, 0);
});

test('adds query context when correction discovery fails before Feishu writes', async () => {
  let archiveCalls = 0;

  await assert.rejects(
    archiveBackfillWithCorrectionApprovals({
      dates: ['2026-09-04'],
      correctionQuery: {
        start: '2026-09-04 00:00:00',
        end: '2026-09-15 23:59:59',
      },
      dingTalkClient: {
        async listCorrectionApprovals() {
          throw new Error('钉钉补卡审批接口已达到当日调用上限 20');
        },
      },
      gateway: {
        async archiveAttendance() {
          archiveCalls += 1;
          return { total: 0, created: 0, updated: 0 };
        },
      },
      async buildArchiveInput(date) {
        return {
          input: { businessDate: date, users: [], results: [], details: [] },
          audit: { date, expected: 1, detailRecords: 0 },
        };
      },
    }),
    /补卡审批查询失败（2026-09-04 00:00:00 至 2026-09-15 23:59:59）：钉钉补卡审批接口已达到当日调用上限 20；尚未写入飞书/u,
  );

  assert.equal(archiveCalls, 0);
});

test('builds a correction query independently from the business backfill dates', () => {
  const now = new Date('2026-09-15T07:23:45.000Z');
  const options = parseBackfillOptions(
    [
      '--from',
      '2026-09-04',
      '--through',
      '2026-09-04',
      '--correction-from',
      '2026-09-04',
      '--correction-through',
      '2026-09-15',
    ],
    now,
  );

  assert.equal(options.correctionFrom, '2026-09-04');
  assert.equal(options.correctionThrough, '2026-09-15');
  assert.deepEqual(buildCorrectionApprovalQuery(options, now), {
    start: '2026-09-04 00:00:00',
    end: '2026-09-15 15:23:45',
  });
});

test('the CLI entrypoint delegates archive writes to the correction-aware workflow', async () => {
  const source = await readFile(
    new URL(
      '../../scripts/backfill-dingtalk-attendance-archive.mjs',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(source, /corrections:\s*\[\]/u);
  assert.match(source, /await archiveBackfillWithCorrectionApprovals\(\{/u);
});
