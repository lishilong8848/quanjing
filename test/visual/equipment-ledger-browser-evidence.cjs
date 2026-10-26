const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const label = process.argv[2] || 'final';
const revision = process.argv[3] === 'revision-3' ? '3' : '2';
if (!/^[a-z0-9-]+$/u.test(label)) throw new Error('invalid evidence label');
(async () => {
  const response = await fetch('http://127.0.0.1:43191/fixture-diagnostics');
  if (!response.ok) throw new Error('fixture diagnostics unavailable');
  const evidence = await response.json();
  fs.writeFileSync(
    path.join(
      root,
      `output/equipment-ledger-revision-${revision}-check/browser-network-${label}.json`,
    ),
    JSON.stringify(evidence, null, 2),
  );
  const queries = evidence.requests.filter((request) =>
    request.path.endsWith('/items'),
  );
  console.log(
    JSON.stringify({
      requests: evidence.requests.length,
      openResponses: evidence.openResponses,
      repeatedDrilldownQueries: queries.filter(
        (request) =>
          request.query.building === 'A楼' && request.query.warranty === '过保',
      ).length,
      timeoutRequests: evidence.requests.filter(
        (request) => request.query.__case === 'timeout',
      ).length,
      delayedQueries: queries
        .filter((request) => request.query.__case === 'late')
        .map((request) => request.query.search),
    }),
  );
})().catch(() => {
  console.error('BROWSER_EVIDENCE_FAILED');
  process.exitCode = 1;
});
