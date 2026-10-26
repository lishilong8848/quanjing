import * as React from 'react';
import * as ReactDOM from 'react-dom';
import type { ReactElement, ReactPortal } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DialogContent, DialogPortal } from '../../client/src/components/ui/dialog';

jest.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }), { virtual: true });

// JSX and mounted/SSR dispatch only. Native focus, exit animation and modal isolation need browser acceptance.
const element = (value: unknown) => value as ReactElement<Record<string, unknown>>;
const children = (node: ReactElement) => React.Children.toArray((node.props as { children?: React.ReactNode }).children).map(element);
const content = (props: Record<string, unknown> = {}) => element(DialogContent(props as React.ComponentProps<typeof DialogContent>));
const renderSingle = (node: ReactElement) => (node.type as (props: unknown) => ReactPortal | null)(node.props);

describe('single physical portal for opted-in dialog', () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  afterEach(() => {
    jest.restoreAllMocks();
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  it('preserves the default Radix portal and sibling layers', () => {
    const node = content({ children: '默认内容' });
    expect(node.type).toBe(DialogPortal);
    expect(children(node)).toHaveLength(2);
    const portal = element(DialogPortal(node.props));
    expect(portal.type).toBe(DialogPrimitive.Portal);
    expect(children(portal)).toHaveLength(2);
  });

  it('selects a dedicated physical portal without an outer Presence or layout wrapper', () => {
    const node = content({ singleContainer: true, children: '申请内容' });
    expect(node.type).not.toBe(DialogPortal);
    expect(typeof node.type).toBe('function');
    expect(children(node)).toHaveLength(2);
    expect(children(node)[1].type).toBe(DialogPrimitive.Content);
    expect(node.props).not.toHaveProperty('singleContainer');
  });

  it('returns null before mounted without reading document or creating a portal', () => {
    jest.spyOn(React, 'useState').mockReturnValue([false, jest.fn()]);
    const effects: (() => void)[] = [];
    jest.spyOn(React, 'useEffect').mockImplementation(effect => { effects.push(effect as () => void); });
    const portal = jest.spyOn(ReactDOM, 'createPortal');
    const node = content({ singleContainer: true, children: '申请内容' });
    expect(renderSingle(node)).toBeNull();
    expect(portal).not.toHaveBeenCalled();
    expect(effects).toHaveLength(1);
  });

  it('mounts both original layers through one createPortal preserving React context', () => {
    jest.spyOn(React, 'useState').mockReturnValue([true, jest.fn()]);
    jest.spyOn(React, 'useEffect').mockImplementation(() => undefined);
    const body = {};
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body } });
    const portal = jest.spyOn(ReactDOM, 'createPortal').mockImplementation((nodes, container) => ({ children: nodes, containerInfo: container }) as unknown as ReactPortal);
    const node = content({ singleContainer: true, children: '申请内容' });
    renderSingle(node);
    expect(portal).toHaveBeenCalledTimes(1);
    expect(portal.mock.calls[0][0]).toBe(node.props.children);
    expect(portal.mock.calls[0][1]).toBe(body);
  });

  it.each([false, true])('retains forceMount, close, animations and handlers in opt-in=%s', singleContainer => {
    const onEscapeKeyDown = jest.fn();
    const node = content({ singleContainer, forceMount: true, onEscapeKeyDown, className: 'leave-sizing', children: '申请内容' });
    const layers = children(node);
    const primitive = layers.find(child => child.type === DialogPrimitive.Content)!;
    expect(primitive.props.forceMount).toBe(true);
    expect(layers[0].props).not.toHaveProperty('forceMount');
    expect(primitive.props.onEscapeKeyDown).toBe(onEscapeKeyDown);
    expect(primitive.props.className).toContain('data-[state=open]:animate-in');
    expect(primitive.props.className).toContain('data-[state=closed]:animate-out');
    expect(primitive.props.className).toContain('leave-sizing');
    expect(children(primitive).some(child => child.type === DialogPrimitive.Close)).toBe(true);
  });
});
