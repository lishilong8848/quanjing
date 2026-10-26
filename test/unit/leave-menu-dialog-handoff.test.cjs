'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), { test } = require('node:test');
const ts = require('typescript');
const sourceFile = path.resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx');
const source = fs.readFileSync(sourceFile, 'utf8'), ast = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements = [];
function walk(node) { if (ts.isJsxElement(node)) elements.push(node); ts.forEachChild(node, walk); }
walk(ast);
const tag = node => node.openingElement.tagName.getText(ast);
const attr = (node, name) => node.openingElement.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === name);
const menu = elements.find(n => tag(n) === 'DropdownMenuContent' && n.getText(ast).includes('请休假&差旅申请'));
const leaveItem = elements.find(n => tag(n) === 'DropdownMenuItem' && n.getText(ast).includes('请休假&差旅申请'));
const leaveRoot = elements.find(n => tag(n) === 'Dialog' && attr(n, 'open')?.initializer?.expression?.getText(ast) === 'leaveRequestDialogOpen');
const leaveContent = elements.find(n => tag(n) === 'DialogContent' && n.parent === leaveRoot);
assert(menu && leaveItem && leaveRoot && leaveContent, 'ACTUAL_LEAVE_JSX_NOT_FOUND');

// Execute actual source callbacks/visibility condition. This does not emulate native Radix focus or animation lifecycle.
function execute(expression, env) {
  const code = ts.transpileModule('(' + expression + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(code, env);
}
function handler(node, name, env) { const expression = attr(node, name)?.initializer?.expression; return expression ? execute(expression.getText(ast), env) : () => {}; }
function menuPresent(env) {
  for (let node = menu.parent; node && node !== ast; node = node.parent) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.left.getText(ast).includes('leaveRequestDialogOpen')) return !!execute(node.left.getText(ast), env);
  }
  return true;
}
function setup() {
  const focuses = [], trigger = { isConnected: true, focus: options => focuses.push(options) };
  const env = { access: { isLoading: false }, leaveApplicant: { mode: 'automatic' }, leaveRequestDialogOpen: false,
    leaveRequestMutationBindingRef: { current: null }, recoveredLeaveRequestMutationId: null,
    commonToolsTriggerRef: { current: trigger }, leaveRequestMenuHandoffRef: { current: false }, leaveRequestReturnFocusRef: { current: null },
    toast: { info() {}, error() {} }, requestLogin() {}, refreshBusinessClock() {},
    setLeaveStartAt() {}, setLeaveEndAt() {}, setLeaveRequestSyncStatus() {}, setLeaveRequestRecoveryState() {}, setLeaveScheduleCoverageReadyKey() {},
  };
  env.setLeaveRequestDialogOpen = open => { env.leaveRequestDialogOpen = open; };
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  return { env, trigger, focuses, event, select: () => handler(leaveItem, 'onSelect', env)(), menuClose: e => handler(menu, 'onCloseAutoFocus', env)(e), leaveClose: e => handler(leaveContent, 'onCloseAutoFocus', env)(e) };
}
test('ordinary tools menu remains mounted and retains default focus return', () => {
  const s = setup(), e = s.event(); assert(menuPresent(s.env)); s.menuClose(e); assert.equal(e.defaultPrevented, false); assert.equal(s.focuses.length, 0);
});
test('successful Leave selection opens immediately without obsolete menu coexistence', () => {
  const s = setup(); s.select(); assert.equal(s.env.leaveRequestDialogOpen, true); assert.equal(menuPresent(s.env), false);
});
test('only Leave handoff suppresses the obsolete menu focus return, once', () => {
  const s = setup(); s.select(); const first = s.event(); s.menuClose(first); assert.equal(first.defaultPrevented, true);
  const ordinary = s.event(); s.menuClose(ordinary); assert.equal(ordinary.defaultPrevented, false);
});
test('Leave close restores the connected tools trigger once without changing modal handlers', () => {
  const s = setup(); s.select(); s.menuClose(s.event()); const close = s.event(); s.leaveClose(close);
  assert.equal(close.defaultPrevented, true); assert.equal(s.focuses.length, 1); assert.equal(s.focuses[0].preventScroll, true);
  s.leaveClose(s.event()); assert.equal(s.focuses.length, 1); s.env.leaveRequestDialogOpen = false; assert(menuPresent(s.env));
  assert(attr(leaveContent, 'singleContainer')); assert.equal(attr(leaveRoot, 'modal'), undefined);
});
test('denied Leave selection does not take menu ownership or change ordinary close', () => {
  for (const mode of ['login', 'error']) { const s = setup(); s.env.leaveApplicant.mode = mode; s.select(); assert.equal(s.env.leaveRequestDialogOpen, false); assert(menuPresent(s.env)); const e = s.event(); s.menuClose(e); assert.equal(e.defaultPrevented, false); }
});
test('disconnected return target and non-menu dialog opening do not steal focus', () => {
  const s = setup(); s.select(); s.trigger.isConnected = false; s.leaveClose(s.event()); assert.equal(s.focuses.length, 0);
  const direct = setup(), e = direct.event(); direct.env.leaveRequestDialogOpen = true; direct.leaveClose(e); assert.equal(e.defaultPrevented, false); assert.equal(direct.focuses.length, 0);
});
