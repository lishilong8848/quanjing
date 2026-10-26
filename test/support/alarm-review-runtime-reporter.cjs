'use strict';
const fs = require('node:fs');
const path = require('node:path');
class RuntimeReporter {
  onRunComplete(_contexts, result) {
    const target = process.env.ALARM_REVIEW_RUNTIME_RESULT;
    const root = path.resolve(__dirname, '../../output/release-next-after-20261005-182903');
    if (!target || path.dirname(path.resolve(target)) !== root) throw new Error('RUNTIME_TEST_RESULT_PATH_REJECTED');
    // Preserve assertion identity/status, never response bodies, cookies or error dumps.
    const safe = {
      kind: 'alarm-review-cross-auth-runtime-results',
      success: result.success,
      startedAt: new Date(result.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      passed: result.numPassedTests, failed: result.numFailedTests,
      suites: result.testResults.map(suite => ({
        file: path.relative(path.resolve(__dirname, '../..'), suite.testFilePath).replace(/\\/g, '/'),
        runtimeError: !!suite.testExecError,
        assertions: suite.testResults.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration,
          failure: test.failureMessages.length ? 'Assertion failed; inspect the named synthetic case without credential dumps.' : null })),
      })),
    };
    fs.writeFileSync(target, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx' });
  }
}
module.exports = RuntimeReporter;
