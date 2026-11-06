import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const text = readFileSync(join(process.cwd(), 'client/src/api/index.ts'), 'utf8');
const source = ts.createSourceFile('api.ts', text, ts.ScriptTarget.Latest, true);

function createReader(name: 'getPersonProfiles' | 'getPersonProfileDetails', bindings: Record<string, unknown>) {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing ${name}`);
  const code = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings)) as
    (force?: boolean, scope?: string, signal?: AbortSignal) => Promise<unknown>;
}

describe.each(['getPersonProfiles', 'getPersonProfileDetails'] as const)('%s request budget', name => {
  afterEach(() => jest.useRealTimers());

  it.each([20_000, 45_000])('allows a %d ms cold read and forwards the 60-second budget and cancellation signal', async delay => {
    jest.useFakeTimers();
    const axiosForBackend = jest.fn(({ timeout }: { timeout: number }) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('client timeout')), timeout);
      setTimeout(() => { clearTimeout(deadline); resolve({ data: { organizations: [] } }); }, delay);
    }));
    const controller = new AbortController();
    const read = createReader(name, { axiosForBackend, logger: { error: jest.fn() } });
    const pending = read(false, 'leave', controller.signal);
    await jest.advanceTimersByTimeAsync(delay);
    await expect(pending).resolves.toMatchObject({ organizations: [] });
    expect(axiosForBackend).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60_000, signal: controller.signal }));
  });

  it('does not log a cancelled read as a load failure, but reports a real failure', async () => {
    const failure = new Error('synthetic');
    const axiosForBackend = jest.fn(async () => { throw failure; });
    const logger = { error: jest.fn() };
    const read = createReader(name, { axiosForBackend, logger });
    const controller = new AbortController();
    controller.abort();
    await expect(read(false, 'leave', controller.signal)).rejects.toBe(failure);
    expect(logger.error).not.toHaveBeenCalled();
    await expect(read()).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
