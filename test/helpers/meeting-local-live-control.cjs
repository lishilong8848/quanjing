const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const port = Number(process.env.MEETING_LOCAL_PORT || 4204);
  assert([4201, 4204].includes(port));
  const base = `http://127.0.0.1:${port}`;
  const session = await fetch(base + '/api/access/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const restore = process.argv.includes('--restore-test-ledger');
  const ledger = path.resolve(
    '.cache/meeting-local-live/workspace/ledger.json',
  );
  if (restore) {
    const proof = JSON.parse(
      fs.readFileSync(
        'output/weekly-local-live-validation-20261009/live-proof.json',
        'utf8',
      ),
    );
    assert.equal(proof.restored, true, '外部原文恢复后才允许清理隔离台账');
    const baseline = JSON.parse(
      fs.readFileSync(ledger + '.before-local-validation', 'utf8'),
    );
    assert(
      !baseline.meetings.length && !Object.keys(baseline.receipts).length,
      '只允许恢复首次隔离空台账',
    );
    const current = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    assert(
      Object.values(current.receipts).every(
        (item) =>
          ['success', 'error'].includes(item.job.status) &&
          ['本地同步验收', ''].includes(item.command.meeting?.note),
      ),
      '发现非验收任务，禁止清理',
    );
  }
  const stop = await fetch(base + '/api/meeting-management/local-stop', {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert([200, 201].includes(stop.status), '本地服务拒绝停止，台账未改动');
  await stop.json();
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(base + '/api/access/session', {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      if (restore) {
        fs.copyFileSync(ledger, ledger + '.local-validation-history');
        fs.copyFileSync(ledger + '.before-local-validation', ledger);
      }
      console.log(
        JSON.stringify({ stopped: true, port, testLedgerRestored: restore }),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('本地后端未安全停止，台账未改动');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
