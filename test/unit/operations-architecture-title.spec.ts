import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { getNavigationBrowserTitle } from '../../client/src/navigation/page-switcher';

describe('business architecture document title', () => {
  it('settles under the real application title owner instead of looping', () => {
    const page = readFileSync(join(process.cwd(), 'client/src/pages/OperationsArchitecture/index.tsx'), 'utf8');
    const app = readFileSync(join(process.cwd(), 'client/src/app.tsx'), 'utf8');
    const hook = app.slice(app.indexOf('function useLockedDocumentTitle()'), app.indexOf('function RouteContentBoundary()'));
    const callbacks = new Set<() => void>();
    const pending: Array<() => void> = [];
    let title = '';
    let writes = 0;
    const effects: Array<() => void> = [];
    const react = {
      useEffect: (effect: () => void) => effects.push(effect),
      useState: () => [false, () => undefined],
      createElement: () => null,
    };
    const document = {
      get title() { return title; },
      set title(value: string) {
        title = value;
        writes += 1;
        pending.push(...callbacks);
      },
      querySelector: () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    class Observer {
      constructor(private callback: () => void) {}
      observe() { callbacks.add(this.callback); }
      disconnect() { callbacks.delete(this.callback); }
    }
    const context = {
      exports: {} as { default: () => void },
      require: (name: string) => name === 'react' ? { ...react, default: react } : {},
      document,
      MutationObserver: Observer,
      window: { setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined },
      useEffect: react.useEffect,
      useLocation: () => ({ pathname: '/operations-architecture' }),
      getNavigationBrowserTitle,
      APP_BROWSER_TITLE: '世纪互联-南通基地',
    };
    const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
    runInNewContext(compile(page), context);
    context.exports.default();
    runInNewContext(`${hook}\nuseLockedDocumentTitle();`, context);
    const cleanup = effects.map((effect) => effect()) as unknown as Array<(() => void) | undefined>;
    let deliveries = 0;
    while (pending.length && deliveries < 100) {
      pending.shift()?.();
      deliveries += 1;
    }
    cleanup.forEach((dispose) => dispose?.());
    expect(pending).toHaveLength(0);
    expect(writes).toBeLessThan(5);
    expect(title).toBe(getNavigationBrowserTitle('/operations-architecture'));
    expect(callbacks.size).toBe(0);
  });
});
