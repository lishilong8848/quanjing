import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidElement, type ReactNode } from 'react';

// Execute the real component and hook transitions without a DOM or any network.
function harness() {
  const file = resolve(__dirname, '../../client/src/pages/SystemConfiguration/CardPanel.tsx');
  const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CardEditor')!;
  const source = ts.transpileModule(`export ${declaration.getText(parsed)}`, { fileName: 'card-editor-fixture.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
  const slots: any[] = []; let cursor = 0, dirty = false; const effects: (() => void)[] = [];
  const exports: Record<string, any> = {}, save = jest.fn();
  const useState = (initial: any) => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next: any) => { const value = typeof next === 'function' ? next(slots[index].value) : next; dirty ||= !Object.is(slots[index].value, value); slots[index].value = value; }]; };
  const context: Record<string, any> = { exports, require: (id: string) => require(id), useState,
    useRef: (initial: any) => { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect: (effect: () => void, deps: unknown[]) => { const index = cursor++; const prior = slots[index]; if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) { slots[index] = { deps }; effects.push(effect); } },
    OPTIONAL: ['warehouse_notify', 'contract_notify'], SINGLE: ['purchase_executor', 'building_executor'], EMPTY_MEMBERS: [],
    CARD_LABELS: { contract_notify: '合同通知人员' }, saveCardRole: save, crypto: { randomUUID: () => 'synthetic-card-mutation' },
    window: { dispatchEvent: jest.fn() }, Event: class { constructor(public type: string) {} },
  };
  for (const name of ['Sheet', 'SheetContent', 'SheetHeader', 'SheetTitle', 'SheetDescription', 'Button', 'PersonSelector', 'X', 'RotateCcw', 'Loader2']) context[name] = name;
  vm.runInNewContext(source, context);
  return { save, render(props: any): ReactNode { let tree: ReactNode; let passes = 0; do { dirty = false; cursor = 0; tree = exports.CardEditor(props); for (const effect of effects.splice(0)) effect(); } while (dirty && ++passes < 10); if (dirty) throw Error('Component did not settle'); return tree; } };
}
function find(node: ReactNode, predicate: (value: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement<any>(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}
const person = (name: string) => ({ name, openId: `ou_${name}` });
const base = () => ({ code: 'contract_notify', building: null, data: { revision: 1, appId: 'synthetic', accounts: [], cardRules: [], audit: [] }, people: [person('a'), person('b')], onClose: jest.fn(), onSaved: jest.fn() });
const selector = (tree: ReactNode) => find(tree, node => node.type === 'PersonSelector');
const saveButton = (tree: ReactNode) => find(tree, node => node.type === 'Button' && Array.isArray(node.props.children) && node.props.children.includes('保存'));
describe('card configuration draft lifecycle', () => {
  it('blocks an unresolved default list and fills the late successful members', () => {
    const instance = harness(), props = base();
    const loading = instance.render(props); expect(saveButton(loading).props.disabled).toBe(true);
    const ready = instance.render({ ...props, defaults: { ready: true, members: [person('a')] } });
    expect(selector(ready).props.selected).toEqual([person('a')]); expect(saveButton(ready).props.disabled).toBe(false);
  });
  it('keeps edited members through refresh failure, then flags a changed source', () => {
    const instance = harness(), props = base(); const first = { ...props, defaults: { ready: true, members: [person('a')] } };
    const ready = instance.render(first); selector(ready).props.onChange([person('b')]);
    const failed = instance.render({ ...props, defaults: { ready: false, members: [person('a')], error: 'synthetic timeout' } });
    expect(selector(failed).props.selected).toEqual([person('b')]); expect(saveButton(failed).props.disabled).toBe(true);
    const changed = instance.render({ ...props, defaults: { ready: true, members: [person('c')] } });
    expect(selector(changed).props.selected).toEqual([person('b')]); expect(saveButton(changed).props.disabled).toBe(true);
  });
  it('requires explicit replacement of a confirmed dynamic notification rule', () => {
    const instance = harness(), props = { ...base(), defaults: { ready: true, members: null, description: '按合同负责人确定' } };
    const before = instance.render(props); expect(saveButton(before).props.disabled).toBe(true);
    const checkbox = find(before, node => node.type === 'input' && node.props.type === 'checkbox');
    checkbox.props.onChange({ target: { checked: true } });
    expect(saveButton(instance.render(props)).props.disabled).toBe(false);
  });
});
