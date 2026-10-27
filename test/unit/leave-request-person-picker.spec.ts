import React from 'react';
import type { ReactElement } from 'react';
import { LeaveRequestPersonPicker } from '../../client/src/pages/MonthlySchedule/LeaveRequestPersonPicker';

jest.mock('@/components/ui/input', () => ({ Input: 'input' }), { virtual: true });
jest.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }), { virtual: true });
jest.mock('lucide-react', () => ({ Check: 'span' }));

// Node-only handler harness: real component handlers and fake clocks, not a DOM renderer.
// Browser acceptance remains required for real focus, layout and pointer interaction.
function mountPicker() {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: (() => void | (() => void))[] = [];
  let stateIndex = 0, refIndex = 0, mounted = false;
  const inputNode = {};
  const outsideNode = {};
  const documentStub = { activeElement: inputNode };
  const container = { contains: (node: unknown) => node === inputNode };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  jest.spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    const index = stateIndex++;
    if (!mounted) states[index] = initial;
    return [states[index], (next: unknown) => {
      states[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(states[index]) : next;
    }];
  }) as typeof React.useState);
  jest.spyOn(React, 'useRef').mockImplementation(((initial: unknown) => {
    const index = refIndex++;
    if (!mounted) refs[index] = { current: initial };
    return refs[index];
  }) as typeof React.useRef);
  jest.spyOn(React, 'useMemo').mockImplementation((factory) => factory());
  jest.spyOn(React, 'useCallback').mockImplementation((callback) => callback);
  jest.spyOn(React, 'useEffect').mockImplementation((effect) => { if (!mounted) effects.push(effect); });
  const onSelect = jest.fn();
  const renderComponent = (LeaveRequestPersonPicker as unknown as { type: (props: object) => ReactElement }).type;
  let tree: ReactElement;
  function render() {
    stateIndex = 0; refIndex = 0;
    tree = renderComponent({ selectedName: '', options: ['张三', '张四'], disabled: false,
      matches: (name: string, search: string) => name.includes(search), onSelect });
    const outerRef = (tree.props as { ref?: { current: unknown } }).ref;
    if (outerRef) outerRef.current = container;
    return tree;
  }
  render();
  const cleanup = effects.map(effect => effect()).filter((value): value is () => void => typeof value === 'function');
  mounted = true;
  const input = () => ((tree.props as { children: ReactElement[] }).children[0].props as {
    onFocus: () => void; onBlur: () => void; onChange: (event: { target: { value: string } }) => void;
  });
  return {
    focus() { documentStub.activeElement = inputNode; input().onFocus(); render(); },
    blur() { documentStub.activeElement = outsideNode; input().onBlur(); render(); },
    change(value: string) { documentStub.activeElement = inputNode; input().onChange({ target: { value } }); render(); },
    isOpen() { render(); return Boolean((tree.props as { children: ReactElement[] }).children[1]); },
    selectFirst() {
      render();
      const list = (tree.props as { children: ReactElement[] }).children[1];
      const first = (list.props as { children: ReactElement[] }).children[0];
      (first.props as { onClick: () => void }).onClick(); render();
    },
    assertMouseProtection() {
      render();
      const list = (tree.props as { children: ReactElement[] }).children[1];
      const first = (list.props as { children: ReactElement[] }).children[0];
      const preventDefault = jest.fn();
      (first.props as { onMouseDown: (event: { preventDefault: () => void }) => void }).onMouseDown({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    },
    unmount() { cleanup.forEach(dispose => dispose()); },
    onSelect,
  };
}

describe('LeaveRequestPersonPicker blur lifecycle', () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    } });
  });
  afterEach(() => {
    jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else Reflect.deleteProperty(globalThis, 'document');
  });

  it('keeps candidates open when refocused before the old blur deadline', () => {
    const picker = mountPicker(); picker.focus(); picker.blur();
    jest.advanceTimersByTime(50); picker.focus();
    jest.advanceTimersByTime(70);
    expect(picker.isOpen()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    picker.unmount();
  });

  it('still closes 120ms after an ordinary blur', () => {
    const picker = mountPicker(); picker.focus(); picker.blur();
    jest.advanceTimersByTime(119); expect(picker.isOpen()).toBe(true);
    jest.advanceTimersByTime(1); expect(picker.isOpen()).toBe(false);
    expect(jest.getTimerCount()).toBe(0); picker.unmount();
  });

  it('cancels a pending blur when new input reopens the list', () => {
    const picker = mountPicker(); picker.focus(); picker.blur();
    jest.advanceTimersByTime(50); picker.change('张');
    jest.advanceTimersByTime(70); expect(picker.isOpen()).toBe(true);
    expect(jest.getTimerCount()).toBe(0); picker.unmount();
  });

  it('cleans a pending blur on unmount', () => {
    const picker = mountPicker(); picker.focus(); picker.blur();
    expect(jest.getTimerCount()).toBe(1); picker.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves mouse focus protection and cancels the old timer on selection', () => {
    const picker = mountPicker(); picker.focus(); picker.assertMouseProtection(); picker.blur();
    picker.selectFirst();
    expect(picker.onSelect).toHaveBeenCalledWith('张三');
    expect(picker.isOpen()).toBe(false); expect(jest.getTimerCount()).toBe(0); picker.unmount();
  });
});
