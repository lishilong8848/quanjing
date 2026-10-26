import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const scriptPath = resolve(__dirname, '../../output/playwright/calendar-follow-up-20261012/performance-samples-p95.js');
function collector() {
  const source = readFileSync(scriptPath, 'utf8');
  const ast = ts.createSourceFile(scriptPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateFixedGroup') declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(declaration).toBeDefined();
  return { source, evaluate: new Function(`${declaration!.getText(ast)};return evaluateFixedGroup;`)() };
}
const sample = (value: number) => ({ kind: 'cached-day-dialog', warmup: false,
  domMs: value, firstRafMs: value, startTime: 200, nativeTime: 190,
  dispatchQueueMs: 10, nativeToDomMs: value, nativeToFirstRafMs: value,
  nativeEventTimingDurationMs: null });

describe('actual fixed performance collector P95', () => {
  it('keeps one slow maximum and warmup, passing nearest-rank P95 without changing raw order', () => {
    const raw = [{ ...sample(900), warmup: true }, ...Array.from({ length: 19 }, () => sample(80)), sample(207)];
    const before = JSON.stringify(raw);
    const result = collector().evaluate(raw, 'cached-day-dialog', 20, 150);
    expect(result).toMatchObject({ count: 20, complete: true, passed: true, p95FirstRafMs: 80, maxFirstRafMs: 207, eventTimingCoverage: 0 });
    expect(JSON.stringify(raw)).toBe(before);
  });
  it('fails when two of twenty exceed the limit', () => {
    const raw = [...Array.from({ length: 18 }, () => sample(80)), sample(151), sample(207)];
    expect(collector().evaluate(raw, 'cached-day-dialog', 20, 150)).toMatchObject({ passed: false, p95FirstRafMs: 151 });
  });
  it.each([NaN, Infinity, -1, undefined, null])('rejects invalid native timings %p without zero filling', value => {
    const raw = Array.from({ length: 20 }, () => sample(80));
    raw[0].nativeTime = value as number;
    expect(collector().evaluate(raw, 'cached-day-dialog', 20, 150)).toMatchObject({ passed: false, valid: false });
  });
  it('does not approve partial fixed groups', () => {
    expect(collector().evaluate([sample(80)], 'cached-day-dialog', 20, 150)).toMatchObject({ passed: false, complete: false });
    expect(collector().evaluate([], 'cached-day-dialog', 20, 150)).toMatchObject({ passed: false, complete: false });
    expect(collector().evaluate(Array.from({ length: 21 }, () => sample(80)), 'cached-day-dialog', 20, 150)).toMatchObject({ passed: false, complete: false });
  });
  it.each([100,150])('accepts only the exact inclusive limit %p', limit => {
    expect(collector().evaluate(Array.from({length:20},()=>sample(limit)), 'cached-day-dialog',20,limit).passed).toBe(true);
    expect(collector().evaluate(Array.from({length:20},()=>sample(limit+.1)), 'cached-day-dialog',20,limit).passed).toBe(false);
  });
  it('uses the tested evaluator for both collected groups without early threshold return', () => {
    const { source } = collector();
    expect(source.includes("evaluateFixedGroup(outputs.samples,'cached-day-dialog',20,150)")).toBe(true);
    expect(source.includes("evaluateFixedGroup(outputs.samples,'compact-picker-feedback',20,100)")).toBe(true);
    expect(source.includes("if(!passed) {outputs.status='failed-cached-dialog'")).toBe(false);
    expect(source.includes("if(!passed){outputs.status='failed-button-feedback'")).toBe(false);
    expect(source.includes("if(!passed || restored!==draft || posts!==1")).toBe(true);
    expect(source.indexOf("outputs.summary={'cached-day-dialog':")).toBeLessThan(source.indexOf("outputs.summary['compact-picker-feedback']="));
    expect(source.includes('outputs.summary=Object.fromEntries')).toBe(false);
    expect(source.includes("acceptance:'every-sample-and-rollback'")).toBe(true);
  });
});
