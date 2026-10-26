'use strict';
const percentile = values => values.length && values.every(v => Number.isFinite(v) && v >= 0)
  ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
function assessClosingFeedback(raw) {
  const captured = raw.capturedEvents || [], timings = raw.eventTimings || [], samples = raw.samples || [];
  const closes = captured.filter(e => e.eventName === 'pointerdown' && e.name === '关闭');
  const selected = closes.slice(1, 21);
  const closeSamples = samples.filter(s => s.name === '关闭' && s.category === 'feedback').slice(1, 21);
  const dialogSamples = samples.filter(s => s.category === 'cached-dialog').slice(1, 21);
  const reasons = [], clicks = [], missingPointerdownSerials = [];
  let wholeGestureNativeCoverage = selected.length === 20;
  if (raw.eventTimingSupported !== true || selected.length !== 20 || closeSamples.length !== 20 || dialogSamples.length !== 20) reasons.push('FIXED_SAMPLE_COVERAGE');
  for (const down of selected) {
    const events = captured.filter(e => e.serial === down.serial && e.name === '关闭');
    const input = ['pointerdown', 'pointerup', 'click'].map(name => events.filter(e => e.eventName === name));
    if (input.some(group => group.length !== 1 || group[0].trusted !== true) ||
        input.every(group => group.length === 1) && !(input[0][0].timeStamp <= input[1][0].timeStamp && input[1][0].timeStamp <= input[2][0].timeStamp)) reasons.push('TRUSTED_INPUT_SEQUENCE');
    const native = timings.filter(e => e.capturedSerial === down.serial && e.name === '关闭');
    for (const name of ['pointerdown', 'pointerup', 'click']) {
      if (!native.some(e => e.eventName === name)) {
        wholeGestureNativeCoverage = false;
        if (name === 'pointerdown') missingPointerdownSerials.push(down.serial);
      }
    }
    const click = native.filter(e => e.eventName === 'click');
    const trustedClick = input[2][0];
    if (click.length !== 1 || !trustedClick || click[0].trusted !== true || click[0].closedState !== true ||
        !Number.isSafeInteger(click[0].interactionId) || click[0].interactionId <= 0 ||
        !Number.isFinite(click[0].duration) || click[0].duration <= 0 || click[0].duration % 8 !== 0 ||
        Math.abs(click[0].startTime - trustedClick.timeStamp) > 1) reasons.push('NATIVE_CLOSING_CLICK_COVERAGE');
    else clicks.push(click[0]);
  }
  if (new Set(selected.map(e => e.serial)).size !== 20 || new Set(clicks.map(e => e.interactionId)).size !== 20) reasons.push('UNIQUE_INTERACTION_IDENTITY');
  if ([...closeSamples, ...dialogSamples].some(s => s.ready !== true || s.focused !== true || s.visibility !== 'visible' || s.requests !== 0)) reasons.push('READINESS_OR_NETWORK');
  const clickP95Ms = clicks.length === 20 ? percentile(clicks.map(e => e.duration)) : null;
  const clickP95UpperMs = clickP95Ms === null ? null : clickP95Ms + 4;
  const closeDomProxyP95Ms = closeSamples.length === 20 ? percentile(closeSamples.map(s => s.elapsedMs)) : null;
  const dialogP95Ms = dialogSamples.length === 20 ? percentile(dialogSamples.map(s => s.elapsedMs)) : null;
  if (clickP95UpperMs === null || clickP95UpperMs > 100 || closeDomProxyP95Ms === null || closeDomProxyP95Ms > 100 || dialogP95Ms === null || dialogP95Ms > 150) reasons.push('PERFORMANCE_LIMIT');
  return { criterion: 'existing engineering standard: closing-button visible feedback, not pointerdown-to-paint for the whole gesture',
    selection: 'first warmup excluded; next twenty by original sequence; surplus retained, not selected by duration',
    selectedSerials: selected.map(e => e.serial), interactionIds: clicks.map(e => e.interactionId),
    clickP95Ms, clickP95UpperMs, closeDomProxyP95Ms, dialogP95Ms,
    wholeGestureNativeCoverage, missingPointerdownSerials, reasons: [...new Set(reasons)],
    closingFeedbackPassed: reasons.length === 0, releaseApproved: false,
    limitation: 'Missing pointerdown native timings remain unknown. This supplement does not change original helper performancePassed=false or prove complete whole-gesture timing, host root cause, live production performance, external resources or release safety.' };
}
module.exports = { assessClosingFeedback };
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const root = path.resolve(__dirname, '../..');
  const resultPath = path.join(root, 'output/admin-configuration-check/foreground-performance-run-vnet-admin-foreground-PeCZRC.json');
  const preparedPath = path.join(root, 'output/admin-configuration-check/render-isolation-manual-fixed-20261007/prepared.json');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash(resultPath) !== '200641880d777c050f3ae867cff62c88692163b8cc8471cea380e6aeae7ede65' ||
      hash(preparedPath) !== 'f492087733dd76c712d36103cb7d33d96feaef18abde0b79ca2c1c6e1fa9117f') throw new Error('ORIGINAL_EVIDENCE_DRIFT');
  const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));
  for (const item of [...prepared.inputs, ...prepared.assets, prepared.node, prepared.chrome]) {
    if (hash(item.path) !== item.sha256) throw new Error('FROZEN_INPUT_DRIFT');
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const report = { generatedAt: new Date().toISOString(), evidenceKind: 'post-execution pure-data supplement, not new browser evidence',
    tool: { path: __filename, sha256: hash(__filename) }, node: { path: process.execPath, sha256: hash(process.execPath), version: process.version },
    originals: [{ path: resultPath, sha256: hash(resultPath) }, { path: preparedPath, sha256: hash(preparedPath) }],
    currentFrozenInputsMatched: prepared.inputs.length, assetsMatched: prepared.assets.length,
    originalMetrics: result.metrics, observedCleanup: result.cleanup, resourceRejects: result.rejectedRequests,
    assessment: assessClosingFeedback(result.raw) };
  const output = path.join(root, 'output/release-next-after-20261006-214606/closing-feedback-supplement-20261007.json');
  if (process.argv.includes('--record')) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: process.argv.includes('--record') ? output : null, ...report }));
  if (!report.assessment.closingFeedbackPassed) process.exitCode = 1;
}
