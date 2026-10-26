import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const {
  verifyServerRuntimeImports,
} = require('../../scripts/verify-server-runtime-import-declarations.cjs');

describe('server runtime dependency declaration preflight', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runtime-import-preflight-'));
    mkdirSync(join(root, 'server'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { fflate: '^0.8.2' },
        devDependencies: { xlsx: '^0.18.5' },
      }),
    );
    writeFileSync(
      join(root, 'tsconfig.node.json'),
      JSON.stringify({
        compilerOptions: { module: 'commonjs', target: 'es2020' },
        include: ['server/**/*.ts'],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('finds all emitted static and literal dynamic dev-only imports before building', () => {
    writeFileSync(
      join(root, 'server/main.ts'),
      "import * as XLSX from 'xlsx'; export const read = XLSX.read; export const later = () => import('xlsx');",
    );
    const result = verifyServerRuntimeImports(root);
    expect(result.failures).toHaveLength(2);
    expect(
      result.failures.every(
        (x: any) => x.dependency === 'xlsx' && x.declaredDevOnly,
      ),
    ).toBe(true);
  });
  it('allows type-only imports, node builtins and declared production imports', () => {
    writeFileSync(
      join(root, 'server/main.ts'),
      "import type { WorkBook } from 'xlsx'; import { readFileSync } from 'node:fs'; import { unzipSync } from 'fflate'; export const read = (book: WorkBook) => unzipSync(readFileSync('test')); ",
    );
    expect(verifyServerRuntimeImports(root).failures).toEqual([]);
  });
  it('ignores test-only imports but rejects undeclared runtime packages', () => {
    writeFileSync(
      join(root, 'server/other.spec.ts'),
      "import * as XLSX from 'xlsx'; export const a = XLSX.read;",
    );
    writeFileSync(
      join(root, 'server/main.ts'),
      "export const a = require('not-declared/subpath');",
    );
    expect(verifyServerRuntimeImports(root)).toMatchObject({
      files: 1,
      failures: [
        { dependency: 'not-declared/subpath', declaredDevOnly: false },
      ],
    });
  });
});
