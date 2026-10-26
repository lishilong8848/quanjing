import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRequire = createRequire(import.meta.url);
const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/u, '')]),
);
const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const WINDOWS = process.platform === 'win32';
const TRUSTED_WINDOWS_ROOT = String.raw`C:\Windows`;
const WINDOWS_ADS_AUDIT_TIMEOUT_MS = 120_000;
const DEFAULT_LIMITS = Object.freeze({
  deadlineMs: 480_000,
  maxBytes: 1024 * 1024 * 1024,
  maxDepth: 64,
  maxEntries: 60_000,
  maxFiles: 50_000,
  maxImports: 100_000,
  maxPackages: 2_000,
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const toUnixPath = (value) => value.split(sep).join('/');
const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const pathKey = (value) => {
  const normalized = resolve(value).replace(/[\\/]+$/u, '');
  return WINDOWS ? normalized.toLocaleLowerCase('en-US') : normalized;
};
const isWithin = (parent, child) => {
  const candidate = relative(parent, child);
  return (
    candidate === '' ||
    (!candidate.startsWith(`..${sep}`) &&
      candidate !== '..' &&
      !isAbsolute(candidate))
  );
};

const createResourceBudget = (overrides = {}) => {
  const unknown = Object.keys(overrides).filter(
    (key) => !Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key),
  );
  if (unknown.length) throw new Error('Invalid runtime closure limits');
  const values = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(values)) {
    const allowsZero = ['maxDepth', 'maxImports', 'maxPackages'].includes(name);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (!allowsZero && value === 0)
    ) {
      throw new Error('Invalid runtime closure limits');
    }
  }
  const startedAt = Date.now();
  const seenEntries = new Set();
  const seenFiles = new Set();
  let bytes = 0;
  let entries = 0;
  let files = 0;
  const reject = (name) => {
    throw new Error(`Runtime closure resource limit exceeded: ${name}`);
  };
  const checkDeadline = () => {
    if (Date.now() - startedAt > values.deadlineMs) reject('deadline');
  };
  return {
    checkDeadline,
    observeDepth(depth) {
      checkDeadline();
      if (depth > values.maxDepth) reject('depth');
    },
    observeEntry(entryPath, depth) {
      checkDeadline();
      this.observeDepth(depth);
      const key = pathKey(entryPath);
      if (seenEntries.has(key)) return;
      if (entries + 1 > values.maxEntries) reject('entries');
      seenEntries.add(key);
      entries += 1;
    },
    observeFile(filePath, size, depth) {
      checkDeadline();
      this.observeDepth(depth);
      if (!Number.isSafeInteger(size) || size < 0 || size > values.maxBytes) {
        reject('bytes');
      }
      const key = pathKey(filePath);
      if (seenFiles.has(key)) return;
      if (files + 1 > values.maxFiles) reject('files');
      if (bytes + size > values.maxBytes) reject('bytes');
      seenFiles.add(key);
      files += 1;
      bytes += size;
    },
    observeImport(count) {
      checkDeadline();
      if (count > values.maxImports) reject('imports');
    },
    observePackage(count, depth) {
      checkDeadline();
      this.observeDepth(depth);
      if (count > values.maxPackages) reject('packages');
    },
  };
};

let typescript;
let acorn;
const getAcorn = () => {
  if (acorn) return acorn;
  try {
    acorn = toolRequire('acorn');
  } catch {
    throw new Error('JavaScript AST parser is unavailable');
  }
  return acorn;
};

const getTypescript = () => {
  if (typescript) return typescript;
  try {
    typescript = toolRequire('typescript');
  } catch {
    throw new Error('JavaScript AST parser is unavailable');
  }
  return typescript;
};

const assertValidJavaScript = (source, fileLabel) => {
  const parser = getAcorn();
  const options = {
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    ecmaVersion: 'latest',
  };
  try {
    return parser.parse(source, { ...options, sourceType: 'module' });
  } catch {
    try {
      return parser.parse(source, { ...options, sourceType: 'script' });
    } catch {
      throw new Error(`JavaScript parse failure in ${fileLabel}`);
    }
  }
};

const statIdentity = (stats) =>
  [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
    stats.nlink,
  ].join(':');

const assertDirectoryIdentity = (
  { absolutePath, identity, label },
  { verifyCanonical = true } = {},
) => {
  try {
    const stats = lstatSync(absolutePath, { bigint: true });
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      statIdentity(stats) !== identity ||
      (verifyCanonical &&
        pathKey(nativeRealpath(absolutePath)) !== pathKey(absolutePath))
    ) {
      throw new Error('changed');
    }
  } catch {
    throw new Error(
      `Concurrent mutation detected in runtime directory identity: ${label}`,
    );
  }
};

const assertDirectoryChainIdentity = (directories = [], options = {}) => {
  for (const directory of directories) {
    assertDirectoryIdentity(directory, options);
  }
};

const assertSingleLink = (stats, label) => {
  if (stats.nlink !== 1n) {
    throw new Error(`Hard-linked file is not allowed: ${label}`);
  }
};

const nativeRealpath = (value) =>
  typeof realpathSync.native === 'function'
    ? realpathSync.native(value)
    : realpathSync(value);

const assertStrictPath = (inputPath, label, expectedType) => {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) throw new Error(`Missing ${label}`);
  let stats;
  try {
    stats = lstatSync(absolutePath, { bigint: true });
  } catch {
    throw new Error(`Unable to inspect ${label}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Reparse path is not allowed: ${label}`);
  }
  if (expectedType === 'directory' && !stats.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  if (expectedType === 'file' && !stats.isFile()) {
    throw new Error(`${label} must be an ordinary file`);
  }
  if (expectedType === 'file') assertSingleLink(stats, label);
  let canonicalPath;
  try {
    canonicalPath = nativeRealpath(absolutePath);
  } catch {
    throw new Error(`Unable to resolve ${label}`);
  }
  if (pathKey(canonicalPath) !== pathKey(absolutePath)) {
    throw new Error(`Reparse path is not allowed: ${label}`);
  }
  return { absolutePath, canonicalPath, stats };
};

const inspectOrdinaryFile = (inputPath, label) => {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) throw new Error(`Missing ${label}`);
  let stats;
  try {
    stats = lstatSync(absolutePath, { bigint: true });
  } catch {
    throw new Error(`Unable to inspect ${label}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Reparse path is not allowed: ${label}`);
  }
  if (!stats.isFile()) throw new Error(`${label} must be an ordinary file`);
  assertSingleLink(stats, label);
  return { absolutePath, canonicalPath: absolutePath, stats };
};

const inspectOrdinaryDirectory = (inputPath, label) => {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) throw new Error(`Missing ${label}`);
  let stats;
  try {
    stats = lstatSync(absolutePath, { bigint: true });
  } catch {
    throw new Error(`Unable to inspect ${label}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Reparse path is not allowed: ${label}`);
  }
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory`);
  return { absolutePath, canonicalPath: absolutePath, stats };
};

const readStableFile = (
  inputPath,
  label,
  { ancestorDirectories = [], budget, depth = 0, verifyCanonical = true } = {},
) => {
  assertDirectoryChainIdentity(ancestorDirectories, {
    verifyCanonical: false,
  });
  const initial = verifyCanonical
    ? assertStrictPath(inputPath, label, 'file')
    : inspectOrdinaryFile(inputPath, label);
  const initialSize = Number(initial.stats.size);
  budget?.observeFile(initial.absolutePath, initialSize, depth);
  let descriptor;
  try {
    descriptor = openSync(initial.absolutePath, 'r');
  } catch {
    throw new Error(`Unable to open ${label}`);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertSingleLink(before, label);
    if (
      !before.isFile() ||
      statIdentity(before) !== statIdentity(initial.stats)
    ) {
      throw new Error(`Concurrent mutation detected while reading ${label}`);
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalStats = lstatSync(initial.absolutePath, { bigint: true });
    assertDirectoryChainIdentity(ancestorDirectories, {
      verifyCanonical: false,
    });
    assertSingleLink(after, label);
    assertSingleLink(finalStats, label);
    const finalRealpath = verifyCanonical
      ? nativeRealpath(initial.absolutePath)
      : initial.absolutePath;
    if (
      statIdentity(before) !== statIdentity(after) ||
      statIdentity(after) !== statIdentity(finalStats) ||
      (verifyCanonical &&
        pathKey(finalRealpath) !== pathKey(initial.canonicalPath)) ||
      BigInt(contents.length) !== after.size
    ) {
      throw new Error(`Concurrent mutation detected while reading ${label}`);
    }
    return {
      absolutePath: initial.absolutePath,
      buffer: contents,
      canonicalPath: initial.canonicalPath,
      hash: sha256(contents),
      size: contents.length,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('Concurrent mutation') ||
        error.message.startsWith('Hard-linked file'))
    ) {
      throw error;
    }
    throw new Error(`Unable to read ${label}`);
  } finally {
    closeSync(descriptor);
  }
};

const withoutBuffer = ({ buffer: _buffer, ...metadata }) => metadata;

const readStableJsonFile = (inputPath, label, options = {}) => {
  const stable = readStableFile(inputPath, label, options);
  return {
    file: withoutBuffer(stable),
    value: parseJsonFile(stable, label),
  };
};

const readSnapshotEntry = (entry, label, budget) => {
  if (typeof entry.hash !== 'string') {
    let current;
    try {
      current = lstatSync(entry.absolutePath, { bigint: true });
    } catch {
      throw new Error(`Concurrent mutation detected while reading ${label}`);
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      statIdentity(current) !== entry.identity ||
      Number(current.size) !== entry.size
    ) {
      throw new Error(`Concurrent mutation detected while reading ${label}`);
    }
    const stable = readStableFile(entry.absolutePath, label, {
      ancestorDirectories: entry.ancestorDirectories,
      budget,
      verifyCanonical: false,
    });
    if (stable.size !== entry.size) {
      throw new Error(`Concurrent mutation detected while reading ${label}`);
    }
    return stable;
  }
  const stable = readStableFile(entry.absolutePath, label, {
    ancestorDirectories: entry.ancestorDirectories,
    budget,
    verifyCanonical: false,
  });
  if (stable.hash !== entry.hash || stable.size !== entry.size) {
    throw new Error(`Concurrent mutation detected while reading ${label}`);
  }
  return stable;
};

const parseJsonFile = (file, label) => {
  try {
    return JSON.parse(file.buffer.toString('utf8'));
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
};

export const assertCaseUniqueRuntimePaths = (paths) => {
  const seen = new Map();
  for (const candidate of paths) {
    const folded = candidate.toLocaleLowerCase('en-US');
    const previous = seen.get(folded);
    if (previous) {
      throw new Error(
        `Case-colliding runtime paths: ${previous}, ${candidate}`,
      );
    }
    seen.set(folded, candidate);
  }
};

const snapshotTree = (
  rootPath,
  rootLabel,
  {
    frozenTreeFast = false,
    metadataOnlyFiles = false,
    rejectMaps = false,
    rejectNativeAddons = false,
    skipNodeModules = false,
    budget,
  } = {},
) => {
  budget?.checkDeadline();
  const root = assertStrictPath(rootPath, rootLabel, 'directory');
  const rootDirectory = {
    absolutePath: root.absolutePath,
    identity: statIdentity(root.stats),
    label: rootLabel,
  };
  budget?.observeEntry(root.absolutePath, 0);
  const entries = [];
  const byPath = new Map();
  const visit = (
    directory,
    relativeDirectory = '',
    ancestorDirectories = [rootDirectory],
  ) => {
    budget?.checkDeadline();
    if (!frozenTreeFast) assertDirectoryChainIdentity(ancestorDirectories);
    let children;
    let directoryHandle;
    try {
      children = [];
      directoryHandle = opendirSync(directory);
      while (true) {
        const child = directoryHandle.readSync();
        if (!child) break;
        const childRelativePath = relativeDirectory
          ? `${relativeDirectory}/${child.name}`
          : child.name;
        budget?.observeEntry(
          join(directory, child.name),
          childRelativePath.split('/').length,
        );
        children.push(child);
      }
      if (!frozenTreeFast) assertDirectoryChainIdentity(ancestorDirectories);
      directoryHandle.closeSync();
      directoryHandle = undefined;
      children.sort((left, right) => compareUtf8(left.name, right.name));
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('Runtime closure resource limit exceeded:') ||
          error.message.startsWith(
            'Concurrent mutation detected in runtime directory identity:',
          ))
      ) {
        throw error;
      }
      if (!frozenTreeFast) assertDirectoryChainIdentity(ancestorDirectories);
      throw new Error(`Unable to enumerate ${rootLabel}`);
    } finally {
      try {
        directoryHandle?.closeSync();
      } catch {
        // The fixed enumeration error above is sufficient and path-safe.
      }
    }
    for (const child of children) {
      if (!frozenTreeFast) {
        assertDirectoryChainIdentity(ancestorDirectories, {
          verifyCanonical: false,
        });
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const depth = relativePath.split('/').length;
      if (
        skipNodeModules &&
        child.name === 'node_modules' &&
        child.isDirectory()
      ) {
        continue;
      }
      const absolutePath = join(directory, child.name);
      const label = `${rootLabel}/${relativePath}`;
      if (child.isDirectory()) {
        const inspected = metadataOnlyFiles
          ? inspectOrdinaryDirectory(absolutePath, label)
          : assertStrictPath(absolutePath, label, 'directory');
        const directoryIdentity = {
          absolutePath: inspected.absolutePath,
          identity: statIdentity(inspected.stats),
          label,
        };
        const entry = {
          absolutePath: inspected.absolutePath,
          canonicalPath: inspected.canonicalPath,
          kind: 'directory',
          label,
          relativePath,
        };
        entries.push(entry);
        byPath.set(pathKey(entry.absolutePath), entry);
        visit(entry.absolutePath, relativePath, [
          ...ancestorDirectories,
          directoryIdentity,
        ]);
        continue;
      }
      if (!child.isFile()) {
        let stats;
        try {
          stats = lstatSync(absolutePath, { bigint: true });
        } catch {
          throw new Error(`Unable to inspect runtime entry: ${label}`);
        }
        if (stats.isSymbolicLink()) {
          throw new Error(`Reparse path is not allowed: ${label}`);
        }
        throw new Error(`Non-ordinary runtime entry: ${label}`);
      }
      const lowered = relativePath.toLocaleLowerCase('en-US');
      if (rejectMaps && lowered.endsWith('.map')) {
        throw new Error(`Source map is not allowed: ${label}`);
      }
      if (rejectNativeAddons && lowered.endsWith('.node')) {
        throw new Error(`Native addon is not allowed: ${label}`);
      }
      if (metadataOnlyFiles) {
        const inspected = inspectOrdinaryFile(absolutePath, label);
        const size = Number(inspected.stats.size);
        budget?.observeFile(absolutePath, size, depth);
        const entry = {
          absolutePath: inspected.absolutePath,
          ancestorDirectories,
          canonicalPath: inspected.canonicalPath,
          identity: statIdentity(inspected.stats),
          kind: 'file',
          label,
          relativePath,
          size,
        };
        entries.push(entry);
        byPath.set(pathKey(entry.absolutePath), entry);
        continue;
      }
      const stable = readStableFile(absolutePath, label, {
        ancestorDirectories: frozenTreeFast ? [] : ancestorDirectories,
        budget,
        depth,
        verifyCanonical: false,
      });
      const entry = {
        ...withoutBuffer(stable),
        ancestorDirectories,
        kind: 'file',
        label,
        relativePath,
      };
      entries.push(entry);
      byPath.set(pathKey(entry.absolutePath), entry);
    }
  };
  visit(root.absolutePath, '', [rootDirectory]);
  if (frozenTreeFast) assertDirectoryIdentity(rootDirectory);
  assertCaseUniqueRuntimePaths(entries.map((entry) => entry.label));
  assertCaseUniqueRuntimePaths(
    entries.map((entry) => toUnixPath(entry.canonicalPath)),
  );
  const digest = sha256(
    entries
      .map((entry) =>
        entry.kind === 'file'
          ? typeof entry.hash === 'string'
            ? `file\0${entry.relativePath}\0${entry.size}\0${entry.hash}`
            : `file-metadata\0${entry.relativePath}\0${entry.size}\0${entry.identity}`
          : `directory\0${entry.relativePath}`,
      )
      .sort(compareUtf8)
      .join('\n'),
  );
  return {
    byPath,
    digest,
    entries,
    files: entries.filter((entry) => entry.kind === 'file'),
    root: root.absolutePath,
    rootLabel,
  };
};

const resolveTrustedWindowsPowerShell = () => {
  try {
    const root = resolve(TRUSTED_WINDOWS_ROOT);
    const system32 = join(root, 'System32');
    const windowsPowerShell = join(system32, 'WindowsPowerShell');
    const versionRoot = join(windowsPowerShell, 'v1.0');
    const executable = join(versionRoot, 'powershell.exe');
    for (const directory of [root, system32, windowsPowerShell, versionRoot]) {
      const stats = lstatSync(directory, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('untrusted');
      }
    }
    const executableStats = lstatSync(executable, { bigint: true });
    const executableRealPath = nativeRealpath(executable);
    if (
      !executableStats.isFile() ||
      executableStats.isSymbolicLink() ||
      pathKey(executableRealPath) !== pathKey(executable)
    ) {
      throw new Error('untrusted');
    }
    return executableRealPath;
  } catch {
    throw new Error('Alternate data stream verification is unavailable');
  }
};

const getTrustedWindowsPowerShellEnvironment = () => {
  const system32 = join(TRUSTED_WINDOWS_ROOT, 'System32');
  const powerShellRoot = join(system32, 'WindowsPowerShell', 'v1.0');
  return {
    SystemRoot: TRUSTED_WINDOWS_ROOT,
    windir: TRUSTED_WINDOWS_ROOT,
    ComSpec: join(system32, 'cmd.exe'),
    Path: [system32, join(system32, 'Wbem'), powerShellRoot].join(';'),
    PSModulePath: join(powerShellRoot, 'Modules'),
  };
};

const WINDOWS_ADS_AUDIT_SCRIPT = [
  '& {',
  "$ErrorActionPreference = 'Stop'",
  '$encodedPayload = [Console]::In.ReadToEnd().Trim()',
  'if ([string]::IsNullOrWhiteSpace($encodedPayload)) { exit 43 }',
  '$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))',
  '$payload = $payloadJson | ConvertFrom-Json -ErrorAction Stop',
  '$paths = @($payload.paths)',
  'if ($paths.Count -gt 60000) { exit 44 }',
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Threading;',
  'using System.Threading.Tasks;',
  'public static class CodexRuntimeClosureStreamAudit {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  private struct FindStreamData {',
  '    public long StreamSize;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)]',
  '    public string StreamName;',
  '  }',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern IntPtr FindFirstStreamW(string path, int level, out FindStreamData data, uint flags);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool FindNextStreamW(IntPtr handle, out FindStreamData data);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool FindClose(IntPtr handle);',
  '  private static string ExtendedPath(string path) {',
  '    if (path.StartsWith(@"\\\\?\\", StringComparison.Ordinal)) { return path; }',
  '    if (path.StartsWith(@"\\\\", StringComparison.Ordinal)) {',
  '      return @"\\\\?\\UNC\\" + path.Substring(2);',
  '    }',
  '    return @"\\\\?\\" + path;',
  '  }',
  '  public static int Audit(string path) {',
  '    FindStreamData data;',
  '    IntPtr handle = FindFirstStreamW(ExtendedPath(path), 0, out data, 0);',
  '    if (handle == new IntPtr(-1)) {',
  '      return Marshal.GetLastWin32Error() == 38 ? 0 : -1;',
  '    }',
  '    try {',
  '      while (true) {',
  '        if (!String.Equals(data.StreamName, "::$DATA", StringComparison.Ordinal)) { return 1; }',
  '        if (FindNextStreamW(handle, out data)) { continue; }',
  '        return Marshal.GetLastWin32Error() == 38 ? 0 : -1;',
  '      }',
  '    } finally { FindClose(handle); }',
  '  }',
  '  public static int AuditAll(string[] paths) {',
  '    int result = 0;',
  '    Parallel.ForEach(paths, new ParallelOptions { MaxDegreeOfParallelism = 16 }, (path, state) => {',
  '      if (Volatile.Read(ref result) != 0) { state.Stop(); return; }',
  '      int audit = Audit(path);',
  '      if (audit != 0) {',
  '        Interlocked.CompareExchange(ref result, audit, 0);',
  '        state.Stop();',
  '      }',
  '    });',
  '    return result;',
  '  }',
  '}',
  "'@",
  'try {',
  '  $audit = [CodexRuntimeClosureStreamAudit]::AuditAll([string[]]$paths)',
  '  if ($audit -eq 1) { exit 42 }',
  '  if ($audit -ne 0) { exit 43 }',
  '  exit 0',
  '} catch { exit 43 }',
  '}',
].join('\n');

const assertNoAlternateDataStreams = (paths, budget) => {
  budget?.checkDeadline();
  if (!WINDOWS || paths.length === 0) return;
  const uniquePaths = [
    ...new Set(paths.map((candidate) => resolve(candidate))),
  ].sort(compareUtf8);
  const encodedPayload = Buffer.from(
    JSON.stringify({ paths: uniquePaths }),
    'utf8',
  ).toString('base64');
  const result = spawnSync(
    resolveTrustedWindowsPowerShell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ADS_AUDIT_SCRIPT,
    ],
    {
      cwd: TRUSTED_WINDOWS_ROOT,
      encoding: 'utf8',
      env: getTrustedWindowsPowerShellEnvironment(),
      input: encodedPayload,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      timeout: WINDOWS_ADS_AUDIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status === 42) {
    throw new Error('Alternate data stream is not allowed');
  }
  if (result.status === 44) {
    throw new Error('Runtime closure resource limit exceeded: entries');
  }
  if (result.status !== 0) {
    throw new Error('Alternate data stream verification is unavailable');
  }
  budget?.checkDeadline();
};

const isStaticString = (ts, node) =>
  node &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

const moduleSpecifierOfCall = (ts, node) => {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1)
    return undefined;
  return isStaticString(ts, node.arguments[0])
    ? node.arguments[0].text
    : undefined;
};

const unwrapExpression = (ts, node) => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const staticStringValue = (ts, node, depth = 0) => {
  if (!node || depth > 32) return undefined;
  const expression = unwrapExpression(ts, node);
  if (isStaticString(ts, expression)) return expression.text;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(ts, expression.left, depth + 1);
    const right = staticStringValue(ts, expression.right, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const propertyNameText = (ts, node) => {
  const expression = unwrapExpression(ts, node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return staticStringValue(ts, expression.argumentExpression);
  }
  return undefined;
};

const bindingElementPropertyNameText = (ts, element) => {
  const property = element.propertyName ?? element.name;
  if (ts.isIdentifier(property) || isStaticString(ts, property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property)) {
    return staticStringValue(ts, property.expression);
  }
  return undefined;
};

const isIdentifierNamed = (ts, node, name) => {
  const expression = unwrapExpression(ts, node);
  return ts.isIdentifier(expression) && expression.text === name;
};

const isRequireCall = (ts, node, expectedSpecifier) => {
  if (
    !ts.isCallExpression(node) ||
    !isIdentifierNamed(ts, node.expression, 'require')
  ) {
    return false;
  }
  return moduleSpecifierOfCall(ts, node) === expectedSpecifier;
};

const isSafeCreateRequireBase = (ts, expression) => {
  const base = unwrapExpression(ts, expression);
  if (ts.isIdentifier(base) && base.text === '__filename') return true;
  if (!ts.isPropertyAccessExpression(base) || base.name.text !== 'url')
    return false;
  const owner = unwrapExpression(ts, base.expression);
  return (
    ts.isMetaProperty(owner) &&
    owner.keywordToken === ts.SyntaxKind.ImportKeyword &&
    owner.name.text === 'meta'
  );
};

const isBindingIdentifier = (ts, node) => {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
};

const isNonValuePropertyName = (ts, node) => {
  const parent = node.parent;
  return Boolean(
    parent &&
    ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      (ts.isImportSpecifier(parent) && parent.propertyName === node)),
  );
};

const isDirectCallTarget = (ts, node) => {
  const parent = node.parent;
  return Boolean(
    parent && ts.isCallExpression(parent) && parent.expression === node,
  );
};

const isRequireResolveBase = (ts, node) => {
  const parent = node.parent;
  return Boolean(
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text === 'resolve' &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent,
  );
};

const isRequireMainBase = (ts, node) => {
  const parent = node.parent;
  return Boolean(
    parent &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node &&
    propertyNameText(ts, parent) === 'main',
  );
};

const isCreatedRequireResolveBase = (ts, node, createdRequires) => {
  if (!ts.isIdentifier(node) || !createdRequires.has(node.text)) return false;
  const parent = node.parent;
  return Boolean(
    parent &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node &&
    propertyNameText(ts, parent) === 'resolve' &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent,
  );
};

const isDynamicCodeCallee = (ts, expression) => {
  const current = unwrapExpression(ts, expression);
  if (
    ts.isIdentifier(current) &&
    (current.text === 'eval' || current.text === 'Function')
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return isDynamicCodeCallee(ts, current.right);
  }
  const property = propertyNameText(ts, current);
  if (property !== 'eval' && property !== 'Function') return false;
  const owner = unwrapExpression(ts, current.expression);
  return (
    ts.isIdentifier(owner) &&
    ['global', 'globalThis', 'self', 'window'].includes(owner.text)
  );
};

const auditedComputedDispatchSha256 = new Map([
  [
    'node_modules/@nestjs/axios/dist/index.js',
    '48edb038f1afdb658327d173dca6bebcb3ddac7f2fa0b53865e09f2546465ae6',
  ],
  [
    'node_modules/@nestjs/core/repl/assign-to-object.util.js',
    '53b9b61e7aeca140f3d4659f9b84fcb252c85210ad187cc27bdd7012b73fb154',
  ],
  [
    'node_modules/@nestjs/core/metadata-scanner.js',
    '61eac6af9bc3a79ccf85d20f737f9933be689eca6dfe1c7e83e81e6f33f8da07',
  ],
  [
    'node_modules/cos-nodejs-sdk-v5/sdk/event.js',
    '65a0a13bbb898c7f4631c48d4bdd808bd6a63ee74c8ee4108f77191bd230097e',
  ],
  [
    'node_modules/@nestjs/platform-express/adapters/express-adapter.js',
    '12f9501fd179a0d87865eacf53c5b951e56e55b0e458d7901cc21f504e6c604e',
  ],
  [
    'node_modules/hbs/lib/hbs.js',
    'fdab192a37993e8643e5ce27698fc7e1138b0033e487270f77fd865fa00feab0',
  ],
  [
    'node_modules/drizzle-orm/pg-core/query-builders/select.cjs',
    '6f9156d696eb2f3e48963b6c30daf2e5eefc6a5eebf70ae0f45b4476e602d281',
  ],
  [
    'node_modules/drizzle-orm/relations.cjs',
    '1469bd248a4f1efaa02ddb2e0360e97f961b2ef0459bdfdd705f7d137be213e6',
  ],
  [
    'node_modules/@nestjs/swagger/dist/explorers/api-operation.explorer.js',
    '245bfd67e8ab256352110ff35e4ba94338dd2a6dda8349a39e9c6cebf90eb3e6',
  ],
  [
    'node_modules/@nestjs/swagger/dist/explorers/api-response.explorer.js',
    '00dcf2ea773613d2b11685b013b821538f9495607d89bca05c4d64ac9e3bbb39',
  ],
  [
    'node_modules/@nestjs/swagger/dist/services/model-properties-accessor.js',
    'c3b7f39df75121373149e4bb5b968042a5089ce781fcc3b197aef44842f7c669',
  ],
  [
    'node_modules/@nestjs/swagger/dist/type-helpers/mapped-types.utils.js',
    'df69bc3aca57fda7494f05925f914a05b0a75a596a6a0590857afbffb4997b4c',
  ],
  [
    'node_modules/@nestjs/swagger/dist/type-helpers/partial-type.helper.js',
    '67ded310d19b094aa0813a7da5f33bec82184914e021335209f97f751a39a770',
  ],
  [
    'node_modules/tslib/tslib.js',
    '8855865a058bc0a6df8f5db45347be041a2d6bbe1654216c51a805648c1b6e8a',
  ],
  [
    'node_modules/@nestjs/core/nest-application.js',
    'f5f17f1286ddffd2312b05e1755736dac1d756a3d0027d6147cd0e0040b17f41',
  ],
  [
    'node_modules/@nestjs/core/nest-factory.js',
    'f88a7d912ea0149421d45ce64f5a81fd8c9e3c4858921b14165aa88203a0e5ee',
  ],
  [
    'node_modules/@nestjs/core/scanner.js',
    '25aacb272aa77d180c5e5b169b68f95bbc73d3a17bd813793ef8af2da76647ec',
  ],
  [
    'node_modules/@nestjs/common/module-utils/configurable-module.builder.js',
    '2c4a74174a8dc0b98301afda3ddf48a67ec2af592082f5b077eb4fabf21f3534',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-array.pipe.js',
    '1242bbc564e3a31ca0f4358fef11f8541d786905d2b11406a562d93d91cb7f4d',
  ],
  [
    'node_modules/@nestjs/common/pipes/file/parse-file.pipe.js',
    '27c453967eed0452eedf561bb6743efc444e0d381a5a4787802aeb46364975eb',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-bool.pipe.js',
    '71157c7f05f656dab45208affd5895309b606fea49e1e9e803dc7a1f151b8703',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-date.pipe.js',
    'c4c90e2274de7c7e481a1d852e93256e556b39cf7f2b96beab4c475297bbe0f3',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-enum.pipe.js',
    'cfd6776317055fef3a3fc98f13086b5f955c09434cdbec03501caca92190950a',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-float.pipe.js',
    '1096a9e1fd3e30c5eb91a59cb992e808878bccb92ca0f1ed3baa145e70b9298d',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-int.pipe.js',
    'f2d15d43c0e0a75e7af630a1adca084fe9ee52ddabab2ec5f5bb98eeb1908d9a',
  ],
  [
    'node_modules/@nestjs/common/pipes/parse-uuid.pipe.js',
    '4dd23c113775236dfe1459ad55c549a2e3a288db317ffff9f133170328ff6a59',
  ],
  [
    'node_modules/@nestjs/common/pipes/validation.pipe.js',
    'dc4dca48330c6430f5bc3ee737cc4be6181fc771ddda5a8efe9b74bb54428141',
  ],
]);
const auditedDynamicRequireSha256 = new Map([
  [
    'node_modules/@nestjs/common/utils/load-package.util.js',
    '8fc26b273fe5499285e25355b4368fe8e1527ae217ede53144219c17cf1aa721',
  ],
  [
    'node_modules/@nestjs/core/helpers/load-adapter.js',
    '7970867a441f356a2e257a12e43dbb8022b58631b3076f298058abb46270009a',
  ],
  [
    'node_modules/@nestjs/core/helpers/optional-require.js',
    'c8a109dab1b2461e866fe04b8be5988ccc199a2239c730abc05fc28c0f85d7f2',
  ],
]);
const auditedShadowedCommonJsModuleSha256 = new Map([
  [
    'node_modules/@nestjs/config/dist/conditional.module.js',
    '2265202db341767eba4cbfa171f6eef222d4d778c9dc0dbeee897dc99702cb4e',
  ],
  [
    'node_modules/@nestjs/core/hooks/before-app-shutdown.hook.js',
    'e8ab7bc14240f1c4b59fc0e2176773b75511e24777c51a5fe4981ff8cacb866d',
  ],
  [
    'node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js',
    '63603f766c57c6d59cac2b7a3c734fdcd156e778e8130573f5e0bb9b131121c8',
  ],
  [
    'node_modules/@nestjs/core/hooks/on-app-shutdown.hook.js',
    '12b227a2607b5af1932e354e138094f3390d1acae0d3afcb1223beb11a8aa8e1',
  ],
  [
    'node_modules/@nestjs/core/hooks/on-module-destroy.hook.js',
    '0a7676179e25e97b5ff40b87b766131f0b546e7712bd1e53fa0d381e0acd8311',
  ],
  [
    'node_modules/@nestjs/core/hooks/on-module-init.hook.js',
    'cd5b75c4181e1c8a6c951f49ebbce4ff0919f6fdfad58aee36145652091cb940',
  ],
  [
    'node_modules/@nestjs/core/scanner.js',
    '25aacb272aa77d180c5e5b169b68f95bbc73d3a17bd813793ef8af2da76647ec',
  ],
]);
const auditedSensitiveComputedPropertySha256 = new Map([
  [
    'node_modules/@nestjs/common/services/console-logger.service.js',
    '0df22183b8b270e830cd3e4edd38a4fc94712a4b4ddd257a11abaa48fa550b7b',
  ],
]);
const auditedLiteralEvalSha256 = new Map([
  [
    'node_modules/@nestjs/common/pipes/file/file-type.validator.js',
    '9fd141fb51b71e8cfd41260d9aa589c42e4fa6bf0f56991e9ca46fb9d025c476',
  ],
]);
const auditedBundledRuntimeSha256 = new Map([
  [
    'node_modules/xlsx-js-style/dist/xlsx.min.js',
    'af16b32bf790003c0a6bc912c70706396ec495cf64dfa144c607e7b705bd12c0',
  ],
  [
    'node_modules/@lark-apaas/fullstack-nestjs-core/dist/index.cjs',
    '07c01f331fb06392fdcd133ab7c0671133e8ed0510ed5dd21e973e37ce5b1ee7',
  ],
]);

export const isAuditedBundledRuntimeSource = (fileLabel, source) => {
  const expectedHash = auditedBundledRuntimeSha256.get(fileLabel);
  return expectedHash !== undefined && sha256(source) === expectedHash;
};

const scanImports = (source, fileLabel) => {
  assertValidJavaScript(source, fileLabel);
  let sourceHash;
  const matchesAuditedSource = (auditedHashes) => {
    const expectedHash = auditedHashes.get(fileLabel);
    if (expectedHash === undefined) return false;
    sourceHash ??= sha256(source);
    return sourceHash === expectedHash;
  };
  const allowsAuditedComputedDispatch = matchesAuditedSource(
    auditedComputedDispatchSha256,
  );
  const allowsAuditedDynamicRequire = matchesAuditedSource(
    auditedDynamicRequireSha256,
  );
  const allowsAuditedShadowedCommonJsModule = matchesAuditedSource(
    auditedShadowedCommonJsModuleSha256,
  );
  const allowsAuditedSensitiveComputedProperty = matchesAuditedSource(
    auditedSensitiveComputedPropertySha256,
  );
  const allowsAuditedLiteralEval = matchesAuditedSource(
    auditedLiteralEvalSha256,
  );
  const allowsAuditedBundledRuntime = isAuditedBundledRuntimeSource(
    fileLabel,
    source,
  );
  const ts = getTypescript();
  const sourceFile = ts.createSourceFile(
    fileLabel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics?.length) {
    throw new Error(`JavaScript parse failure in ${fileLabel}`);
  }
  const sourceLocation = (node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    return `${fileLabel}:${line + 1}:${character + 1}`;
  };
  const isAuditedLiteralEvalCall = (node) => {
    if (!allowsAuditedLiteralEval || !ts.isCallExpression(node)) return false;
    const callee = unwrapExpression(ts, node.expression);
    return (
      isIdentifierNamed(ts, callee, 'eval') &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'import ("file-type")'
    );
  };

  const bindingsByName = new Map();
  const identifiersByName = new Map();
  const visitBindings = (node) => {
    if (ts.isIdentifier(node)) {
      const identifiers = identifiersByName.get(node.text) ?? [];
      identifiers.push(node);
      identifiersByName.set(node.text, identifiers);
    }
    if (ts.isIdentifier(node) && isBindingIdentifier(ts, node)) {
      const bindings = bindingsByName.get(node.text) ?? [];
      bindings.push(node);
      bindingsByName.set(node.text, bindings);
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(sourceFile);

  const decoratorMetadataKinds = new Set([
    'design:type',
    'design:paramtypes',
    'design:returntype',
  ]);
  const directDecoratorMetadataHelpers = new Set();
  const metadataBindings = bindingsByName.get('__metadata');
  if (metadataBindings?.length === 1) {
    const metadataBinding = metadataBindings[0];
    const declaration = metadataBinding.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const normalizedInitializer = declaration.initializer
        .getText(sourceFile)
        .replace(/\s+/gu, '');
      let hasOnlySafeUses = true;
      const visitMetadataUses = (node) => {
        if (!hasOnlySafeUses) return;
        if (
          ts.isIdentifier(node) &&
          node.text === '__metadata' &&
          node !== metadataBinding &&
          !isNonValuePropertyName(ts, node)
        ) {
          const invocation = node.parent;
          const metadataKind = invocation?.arguments?.[0];
          if (
            !invocation ||
            !ts.isCallExpression(invocation) ||
            invocation.expression !== node ||
            invocation.arguments.length !== 2 ||
            !isStaticString(ts, metadataKind) ||
            !decoratorMetadataKinds.has(metadataKind.text)
          ) {
            hasOnlySafeUses = false;
            return;
          }
        }
        ts.forEachChild(node, visitMetadataUses);
      };
      visitMetadataUses(sourceFile);
      if (
        hasOnlySafeUses &&
        normalizedInitializer ===
          '(this&&this.__metadata)||function(k,v){if(typeofReflect==="object"&&typeofReflect.metadata==="function")returnReflect.metadata(k,v);}'
      ) {
        directDecoratorMetadataHelpers.add('__metadata');
      }
    }
  }

  const uniqueConstInitializer = (name) => {
    const bindings = bindingsByName.get(name);
    if (!bindings || bindings.length !== 1) return undefined;
    const declaration = bindings[0].parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    ) {
      return undefined;
    }
    return declaration.initializer;
  };
  const staticStringValueInScan = (node, seen = new Set(), depth = 0) => {
    if (!node || depth > 32) return undefined;
    const expression = unwrapExpression(ts, node);
    if (isStaticString(ts, expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return expression.text;
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return undefined;
      const initializer = uniqueConstInitializer(expression.text);
      if (!initializer) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(expression.text);
      return staticStringValueInScan(initializer, nextSeen, depth + 1);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticStringValueInScan(expression.left, seen, depth + 1);
      const right = staticStringValueInScan(expression.right, seen, depth + 1);
      return left === undefined || right === undefined
        ? undefined
        : left + right;
    }
    return undefined;
  };
  const propertyNameTextInScan = (node) => {
    const expression = unwrapExpression(ts, node);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) {
      return staticStringValueInScan(expression.argumentExpression);
    }
    return undefined;
  };
  const resolveUniqueConstExpression = (node, seen = new Set(), depth = 0) => {
    if (!node || depth > 32) return undefined;
    const expression = unwrapExpression(ts, node);
    if (!ts.isIdentifier(expression)) return expression;
    if (seen.has(expression.text)) return undefined;
    const initializer = uniqueConstInitializer(expression.text);
    if (!initializer) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(expression.text);
    return resolveUniqueConstExpression(initializer, nextSeen, depth + 1);
  };

  const createRequireFactories = new Set();
  const moduleNamespaces = new Set();
  const decoratorMetadataNamespaces = new Set();
  const visitFactoryBindings = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      isStaticString(ts, node.moduleSpecifier) &&
      ['module', 'node:module'].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings
    ) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings))
        moduleNamespaces.add(bindings.name.text);
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'createRequire') {
            createRequireFactories.add(element.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (isRequireCall(ts, node.initializer, 'node:module') ||
        isRequireCall(ts, node.initializer, 'module'))
    ) {
      if (ts.isIdentifier(node.name)) moduleNamespaces.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if ((element.propertyName ?? element.name).text === 'createRequire') {
            if (ts.isIdentifier(element.name))
              createRequireFactories.add(element.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isRequireCall(ts, node.initializer, 'tslib')
    ) {
      decoratorMetadataNamespaces.add(node.name.text);
    }
    if (
      ts.isImportDeclaration(node) &&
      isStaticString(ts, node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'tslib' &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      decoratorMetadataNamespaces.add(
        node.importClause.namedBindings.name.text,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isPropertyAccessExpression(unwrapExpression(ts, node.initializer)) ||
        ts.isElementAccessExpression(unwrapExpression(ts, node.initializer)))
    ) {
      const property = unwrapExpression(ts, node.initializer);
      if (
        propertyNameText(ts, property) === 'createRequire' &&
        (isRequireCall(ts, property.expression, 'node:module') ||
          isRequireCall(ts, property.expression, 'module'))
      ) {
        createRequireFactories.add(node.name.text);
      }
    }
    ts.forEachChild(node, visitFactoryBindings);
  };
  visitFactoryBindings(sourceFile);

  const sensitiveAliasKinds = new Map();
  const addSensitiveKinds = (name, kinds) => {
    if (!name || !kinds?.size) return false;
    const current = sensitiveAliasKinds.get(name) ?? new Set();
    const previousSize = current.size;
    for (const kind of kinds) current.add(kind);
    sensitiveAliasKinds.set(name, current);
    return current.size !== previousSize;
  };
  for (const name of ['global', 'globalThis', 'self', 'window']) {
    addSensitiveKinds(name, new Set(['global']));
  }
  addSensitiveKinds('process', new Set(['process']));
  addSensitiveKinds('module', new Set(['module']));
  addSensitiveKinds('Reflect', new Set(['reflect']));
  addSensitiveKinds('Object', new Set(['object']));
  for (const name of moduleNamespaces) {
    addSensitiveKinds(name, new Set(['module']));
  }

  const sensitiveKindsOf = (expression, depth = 0) => {
    if (!expression || depth > 32) return new Set();
    const current = unwrapExpression(ts, expression);
    if (ts.isIdentifier(current)) {
      return sensitiveAliasKinds.get(current.text) ?? new Set();
    }
    if (
      isRequireCall(ts, current, 'module') ||
      isRequireCall(ts, current, 'node:module')
    ) {
      return new Set(['module']);
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      const ownerKinds = sensitiveKindsOf(current.expression, depth + 1);
      const property = propertyNameText(ts, current);
      if (property === 'constructor') {
        const kinds = new Set(['constructor']);
        if (ownerKinds.has('module')) kinds.add('module');
        return kinds;
      }
      if (ownerKinds.has('module') && property === 'Module') {
        return new Set(['module']);
      }
      return new Set();
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(ts, current.expression);
      if (
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        propertyNameText(ts, callee) === 'getBuiltinModule' &&
        sensitiveKindsOf(callee.expression, depth + 1).has('process') &&
        current.arguments.length === 1 &&
        ['module', 'node:module'].includes(
          staticStringValue(ts, current.arguments[0]),
        )
      ) {
        return new Set(['module']);
      }
    }
    return new Set();
  };

  const namedFunctions = new Map();
  const addNamedFunction = (name, declaration) => {
    if (!name) return;
    const declarations = namedFunctions.get(name) ?? [];
    declarations.push(declaration);
    namedFunctions.set(name, declarations);
  };
  const visitNamedFunctions = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addNamedFunction(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(unwrapExpression(ts, node.initializer)) ||
        ts.isArrowFunction(unwrapExpression(ts, node.initializer)))
    ) {
      addNamedFunction(node.name.text, unwrapExpression(ts, node.initializer));
    }
    ts.forEachChild(node, visitNamedFunctions);
  };
  visitNamedFunctions(sourceFile);
  const functionTargetsForCall = (expression, seen = new Set(), depth = 0) => {
    if (!expression || depth > 32) return [];
    const current = unwrapExpression(ts, expression);
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return [current];
    }
    if (!ts.isIdentifier(current) || seen.has(current.text)) return [];
    const direct = namedFunctions.get(current.text);
    if (direct?.length) return direct;
    const initializer = uniqueConstInitializer(current.text);
    if (!initializer) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(current.text);
    return functionTargetsForCall(initializer, nextSeen, depth + 1);
  };

  const aliasRules = [];
  const visitAliasRules = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      aliasRules.push({ expression: node.initializer, name: node.name.text });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(ts, node.left))
    ) {
      aliasRules.push({
        expression: node.right,
        name: unwrapExpression(ts, node.left).text,
      });
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer
    ) {
      const initializer = resolveUniqueConstExpression(node.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        for (
          let index = 0;
          index < node.name.elements.length &&
          index < initializer.elements.length;
          index += 1
        ) {
          const binding = node.name.elements[index];
          if (ts.isBindingElement(binding) && ts.isIdentifier(binding.name)) {
            aliasRules.push({
              expression: initializer.elements[index],
              name: binding.name.text,
            });
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      for (const target of functionTargetsForCall(node.expression)) {
        for (
          let index = 0;
          index < target.parameters.length && index < node.arguments.length;
          index += 1
        ) {
          const parameter = target.parameters[index];
          if (ts.isIdentifier(parameter.name)) {
            aliasRules.push({
              expression: node.arguments[index],
              name: parameter.name.text,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visitAliasRules);
  };
  visitAliasRules(sourceFile);
  const dependentAliasRules = new Map();
  for (const [index, rule] of aliasRules.entries()) {
    const dependencies = new Set();
    const collectDependencies = (node) => {
      if (ts.isIdentifier(node)) dependencies.add(node.text);
      ts.forEachChild(node, collectDependencies);
    };
    collectDependencies(rule.expression);
    for (const dependency of dependencies) {
      const indexes = dependentAliasRules.get(dependency) ?? new Set();
      indexes.add(index);
      dependentAliasRules.set(dependency, indexes);
    }
  }
  const pendingAliasRules = aliasRules.map((_rule, index) => index);
  const queuedAliasRules = new Set(pendingAliasRules);
  while (pendingAliasRules.length) {
    const index = pendingAliasRules.shift();
    queuedAliasRules.delete(index);
    const rule = aliasRules[index];
    if (!addSensitiveKinds(rule.name, sensitiveKindsOf(rule.expression))) {
      continue;
    }
    for (const dependent of dependentAliasRules.get(rule.name) ?? []) {
      if (!queuedAliasRules.has(dependent)) {
        queuedAliasRules.add(dependent);
        pendingAliasRules.push(dependent);
      }
    }
  }

  const isCreateRequireFactory = (expression) => {
    const current = unwrapExpression(ts, expression);
    if (ts.isIdentifier(current))
      return createRequireFactories.has(current.text);
    const property = propertyNameText(ts, current);
    if (property !== 'createRequire') return false;
    const owner = unwrapExpression(ts, current.expression);
    return (
      (ts.isIdentifier(owner) && moduleNamespaces.has(owner.text)) ||
      isRequireCall(ts, owner, 'node:module') ||
      isRequireCall(ts, owner, 'module')
    );
  };

  const createdRequires = new Set();
  const visitCreatedRequires = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(unwrapExpression(ts, node.initializer))
    ) {
      const call = unwrapExpression(ts, node.initializer);
      if (isCreateRequireFactory(call.expression)) {
        if (
          call.arguments.length !== 1 ||
          !isSafeCreateRequireBase(ts, call.arguments[0])
        ) {
          throw new Error(`Unsupported createRequire base in ${fileLabel}`);
        }
        createdRequires.add(node.name.text);
      }
    }
    ts.forEachChild(node, visitCreatedRequires);
  };
  visitCreatedRequires(sourceFile);

  const imports = [];
  const rejectRuntimeLoader = (node) => {
    throw new Error(
      `Unsupported runtime module loader in ${sourceLocation(node)}`,
    );
  };
  const isNamedOwner = (expression, names) => {
    const owner = unwrapExpression(ts, expression);
    if (!ts.isIdentifier(owner)) return false;
    const kinds = sensitiveAliasKinds.get(owner.text) ?? new Set();
    return names.some((name) => {
      if (['global', 'globalThis', 'self', 'window'].includes(name)) {
        return kinds.has('global');
      }
      if (name === 'process') return kinds.has('process');
      if (name === 'module') return kinds.has('module');
      if (name === 'Reflect') return kinds.has('reflect');
      if (name === 'Object') return kinds.has('object');
      return owner.text === name;
    });
  };
  const isSensitiveGlobalProperty = (node) =>
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    isNamedOwner(node.expression, ['global', 'globalThis', 'self', 'window']) &&
    ['eval', 'Function', 'require'].includes(propertyNameText(ts, node));
  const isProcessBuiltinModuleProperty = (node) =>
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    propertyNameText(ts, node) === 'getBuiltinModule' &&
    isNamedOwner(node.expression, ['process']);
  const isReflectGetProperty = (node) =>
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    propertyNameText(ts, node) === 'get' &&
    isNamedOwner(node.expression, ['Reflect']);
  const isObjectPropertyDescriptorProperty = (node) =>
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    propertyNameText(ts, node) === 'getOwnPropertyDescriptor' &&
    isNamedOwner(node.expression, ['Object']);
  const isApprovedEsbuildDescriptorAlias = (node) => {
    if (!isObjectPropertyDescriptorProperty(node)) return false;
    const declaration = node.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== node ||
      !ts.isIdentifier(declaration.name) ||
      !/^__getOwnPropDesc\d*$/u.test(declaration.name.text)
    ) {
      return false;
    }
    const alias = declaration.name.text;
    const identifiers = identifiersByName.get(alias) ?? [];
    if (identifiers.length < 2) return false;
    return identifiers.every((identifier) => {
      if (identifier === declaration.name) return true;
      const call = identifier.parent;
      if (
        !call ||
        !ts.isCallExpression(call) ||
        call.expression !== identifier ||
        call.arguments.length !== 2 ||
        !isIdentifierNamed(ts, call.arguments[0], 'from') ||
        !isIdentifierNamed(ts, call.arguments[1], 'key')
      ) {
        return false;
      }
      let owner = call.parent;
      while (
        owner &&
        !ts.isArrowFunction(owner) &&
        !ts.isFunctionExpression(owner) &&
        !ts.isFunctionDeclaration(owner)
      ) {
        owner = owner.parent;
      }
      if (
        !owner ||
        !owner.parent ||
        !ts.isVariableDeclaration(owner.parent) ||
        owner.parent.initializer !== owner ||
        !ts.isIdentifier(owner.parent.name) ||
        !/^__copyProps\d*$/u.test(owner.parent.name.text)
      ) {
        return false;
      }
      return owner.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === 'from',
      );
    });
  };
  const isDirectPropertyCall = (node) =>
    node.parent &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node;
  const isProcessBuiltinModuleCall = (node) =>
    ts.isCallExpression(node) &&
    isProcessBuiltinModuleProperty(unwrapExpression(ts, node.expression));
  const isModuleLoaderOwner = (expression) => {
    const owner = unwrapExpression(ts, expression);
    return sensitiveKindsOf(owner).has('module');
  };
  const isRuntimeLoaderReflectGet = (node) => {
    if (
      !ts.isCallExpression(node) ||
      (!ts.isPropertyAccessExpression(unwrapExpression(ts, node.expression)) &&
        !ts.isElementAccessExpression(unwrapExpression(ts, node.expression))) ||
      propertyNameText(ts, unwrapExpression(ts, node.expression)) !== 'get' ||
      !isNamedOwner(unwrapExpression(ts, node.expression).expression, [
        'Reflect',
      ]) ||
      node.arguments.length < 2
    ) {
      return false;
    }
    const property = staticStringValueInScan(node.arguments[1]);
    const sensitiveProperties = [
      'eval',
      'Function',
      'require',
      'getBuiltinModule',
      '_load',
    ];
    if (property === undefined) return true;
    return sensitiveProperties.includes(property);
  };
  const isRuntimeLoaderPropertyDescriptor = (node) => {
    if (
      !ts.isCallExpression(node) ||
      !isObjectPropertyDescriptorProperty(
        unwrapExpression(ts, node.expression),
      ) ||
      node.arguments.length < 2
    ) {
      return false;
    }
    const property = staticStringValueInScan(node.arguments[1]);
    if (property === undefined) return true;
    return [
      'eval',
      'Function',
      'require',
      'getBuiltinModule',
      '_load',
      'createRequire',
    ].includes(property);
  };
  const isUnknownSensitiveComputedProperty = (node) => {
    if (
      !ts.isElementAccessExpression(node) ||
      propertyNameText(ts, node) !== undefined
    ) {
      return false;
    }
    const ownerKinds = sensitiveKindsOf(node.expression);
    return ['global', 'process', 'module', 'reflect', 'object'].some((kind) =>
      ownerKinds.has(kind),
    );
  };
  const isDecoratorMetadataFunctionReference = (node) => {
    let valueNode = node;
    let parent = node.parent;
    if (parent && ts.isArrayLiteralExpression(parent)) {
      valueNode = parent;
      parent = parent.parent;
    }
    if (
      !parent ||
      !ts.isCallExpression(parent) ||
      parent.arguments.length !== 2 ||
      parent.arguments[1] !== valueNode
    ) {
      return false;
    }
    const expression = unwrapExpression(ts, parent.expression);
    const metadataKind = parent.arguments[0];
    const isKnownMetadataHelper =
      (ts.isIdentifier(expression) &&
        directDecoratorMetadataHelpers.has(expression.text)) ||
      ((ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)) &&
        propertyNameText(ts, expression) === '__metadata' &&
        ts.isIdentifier(unwrapExpression(ts, expression.expression)) &&
        decoratorMetadataNamespaces.has(
          unwrapExpression(ts, expression.expression).text,
        ));
    return Boolean(
      isKnownMetadataHelper &&
      isStaticString(ts, metadataKind) &&
      decoratorMetadataKinds.has(metadataKind.text),
    );
  };
  const isInstanceofRightOperand = (node) =>
    node.parent &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    node.parent.right === node;
  const isTypeofOperand = (node) =>
    node.parent &&
    ts.isTypeOfExpression(node.parent) &&
    node.parent.expression === node;
  const isFunctionPrototypeToStringCallBase = (node) => {
    const prototypeProperty = node.parent;
    if (
      !prototypeProperty ||
      !ts.isPropertyAccessExpression(prototypeProperty) ||
      prototypeProperty.expression !== node ||
      prototypeProperty.name.text !== 'prototype'
    ) {
      return false;
    }
    const toStringProperty = prototypeProperty.parent;
    if (
      !toStringProperty ||
      !ts.isPropertyAccessExpression(toStringProperty) ||
      toStringProperty.expression !== prototypeProperty ||
      toStringProperty.name.text !== 'toString'
    ) {
      return false;
    }
    const callProperty = toStringProperty.parent;
    if (
      !callProperty ||
      !ts.isPropertyAccessExpression(callProperty) ||
      callProperty.expression !== toStringProperty ||
      callProperty.name.text !== 'call'
    ) {
      return false;
    }
    const invocation = callProperty.parent;
    return Boolean(
      invocation &&
      ts.isCallExpression(invocation) &&
      invocation.expression === callProperty,
    );
  };
  const addStaticCall = (node, kind, mode) => {
    const specifier = moduleSpecifierOfCall(ts, node);
    if (specifier === undefined) {
      if (
        kind === 'require' &&
        (allowsAuditedDynamicRequire || allowsAuditedBundledRuntime)
      ) {
        return;
      }
      const category = kind.includes('require') ? 'require' : kind;
      throw new Error(`Dynamic ${category} is not allowed in ${fileLabel}`);
    }
    imports.push({ kind, mode, specifier });
  };

  const dangerousRuntimeProperties = new Set([
    'eval',
    'Function',
    '_load',
    'createRequire',
    'getBuiltinModule',
  ]);
  const isProvenOrdinaryCallableProperty = (node, property) => {
    if (property !== 'eval' && property !== 'Function') return false;
    const owner = resolveUniqueConstExpression(node.expression);
    if (!owner || !ts.isObjectLiteralExpression(owner)) return false;
    return owner.properties.some((candidate) => {
      const candidateName = bindingElementPropertyNameText(ts, candidate);
      if (candidateName !== property) return false;
      if (ts.isMethodDeclaration(candidate)) return Boolean(candidate.body);
      return (
        ts.isPropertyAssignment(candidate) &&
        (ts.isArrowFunction(candidate.initializer) ||
          ts.isFunctionExpression(candidate.initializer))
      );
    });
  };
  const isApprovedCreateRequirePropertyReference = (node) => {
    if (!isCreateRequireFactory(node)) return false;
    const parent = node.parent;
    return Boolean(
      (parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        parent.initializer === node) ||
      (parent && ts.isCallExpression(parent) && parent.expression === node),
    );
  };
  const isDangerousRuntimePropertyReference = (node) => {
    if (
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)
    ) {
      return false;
    }
    const property = propertyNameTextInScan(node);
    if (!dangerousRuntimeProperties.has(property)) return false;
    if (
      property === 'createRequire' &&
      isApprovedCreateRequirePropertyReference(node)
    ) {
      return false;
    }
    return !isProvenOrdinaryCallableProperty(node, property);
  };
  const invocationTarget = (node) => {
    if (ts.isTaggedTemplateExpression(node)) return node.tag;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return node.expression;
    }
    return undefined;
  };
  const isUnknownComputedInvocation = (node) => {
    const target = unwrapExpression(ts, invocationTarget(node));
    return (
      ts.isElementAccessExpression(target) &&
      propertyNameTextInScan(target) === undefined
    );
  };
  const isRuntimeConstructorInvocation = (node) => {
    const target = unwrapExpression(ts, invocationTarget(node));
    return sensitiveKindsOf(target).has('constructor');
  };

  const visit = (node) => {
    if (
      !allowsAuditedBundledRuntime &&
      isDangerousRuntimePropertyReference(node)
    ) {
      rejectRuntimeLoader(node);
    }
    if (
      (ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node)) &&
      ((!allowsAuditedComputedDispatch &&
        !allowsAuditedBundledRuntime &&
        isUnknownComputedInvocation(node)) ||
        isRuntimeConstructorInvocation(node))
    ) {
      rejectRuntimeLoader(node);
    }
    if (
      !allowsAuditedSensitiveComputedProperty &&
      !allowsAuditedBundledRuntime &&
      isUnknownSensitiveComputedProperty(node)
    ) {
      rejectRuntimeLoader(node);
    }
    if (!allowsAuditedBundledRuntime && isProcessBuiltinModuleProperty(node)) {
      rejectRuntimeLoader(node);
    }
    if (
      !allowsAuditedBundledRuntime &&
      isReflectGetProperty(node) &&
      !isDirectPropertyCall(node)
    ) {
      rejectRuntimeLoader(node);
    }
    if (
      !allowsAuditedBundledRuntime &&
      isObjectPropertyDescriptorProperty(node) &&
      !isDirectPropertyCall(node) &&
      !isApprovedEsbuildDescriptorAlias(node)
    ) {
      rejectRuntimeLoader(node);
    }
    if (!allowsAuditedBundledRuntime && isProcessBuiltinModuleCall(node)) {
      rejectRuntimeLoader(node);
    }
    if (!allowsAuditedBundledRuntime && isSensitiveGlobalProperty(node)) {
      rejectRuntimeLoader(node);
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      propertyNameText(ts, node) === '_load' &&
      isModuleLoaderOwner(node.expression) &&
      !allowsAuditedBundledRuntime
    ) {
      rejectRuntimeLoader(node);
    }
    if (!allowsAuditedBundledRuntime && isRuntimeLoaderReflectGet(node)) {
      rejectRuntimeLoader(node);
    }
    if (
      !allowsAuditedComputedDispatch &&
      !allowsAuditedBundledRuntime &&
      isRuntimeLoaderPropertyDescriptor(node)
    ) {
      rejectRuntimeLoader(node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      !allowsAuditedBundledRuntime &&
      [
        {
          owners: ['module'],
          properties: ['require'],
        },
        {
          owners: ['process'],
          properties: ['getBuiltinModule'],
        },
        {
          owners: ['Reflect'],
          properties: ['get'],
        },
        {
          owners: ['Object'],
          properties: ['getOwnPropertyDescriptor'],
        },
        {
          owners: ['global', 'globalThis', 'self', 'window'],
          properties: ['eval', 'Function', 'require'],
        },
      ].some(
        ({ owners, properties }) =>
          isNamedOwner(node.initializer, owners) &&
          node.name.elements.some((element) => {
            const property = bindingElementPropertyNameText(ts, element);
            return property === undefined || properties.includes(property);
          }),
      )
    ) {
      rejectRuntimeLoader(node);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const sensitiveGlobalCallee = unwrapExpression(ts, node.expression);
      if (
        isSensitiveGlobalProperty(sensitiveGlobalCallee) &&
        propertyNameText(ts, sensitiveGlobalCallee) !== 'require' &&
        !allowsAuditedBundledRuntime
      ) {
        rejectRuntimeLoader(node);
      }
      if (
        isDynamicCodeCallee(ts, node.expression) &&
        !isAuditedLiteralEvalCall(node) &&
        !allowsAuditedBundledRuntime
      ) {
        throw new Error(
          `Dynamic code execution is not allowed in ${fileLabel}`,
        );
      }
    }
    if (ts.isImportDeclaration(node)) {
      if (!isStaticString(ts, node.moduleSpecifier)) {
        throw new Error(
          `Non-static import source is not allowed in ${fileLabel}`,
        );
      }
      imports.push({
        kind: 'import',
        mode: 'esm',
        specifier: node.moduleSpecifier.text,
      });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!isStaticString(ts, node.moduleSpecifier)) {
        throw new Error(
          `Non-static export source is not allowed in ${fileLabel}`,
        );
      }
      imports.push({
        kind: 'export',
        mode: 'esm',
        specifier: node.moduleSpecifier.text,
      });
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      propertyNameText(ts, node) === 'require'
    ) {
      const owner = unwrapExpression(ts, node.expression);
      const directModuleCall =
        ts.isIdentifier(owner) &&
        owner.text === 'module' &&
        node.parent &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      if (!directModuleCall && !allowsAuditedBundledRuntime) {
        rejectRuntimeLoader(node);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(ts, node.expression);
      if (isAuditedLiteralEvalCall(node)) {
        imports.push({
          kind: 'audited eval import()',
          mode: 'esm',
          specifier: 'file-type',
        });
      } else if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        addStaticCall(node, 'import()', 'esm');
      } else if (isIdentifierNamed(ts, expression, 'require')) {
        addStaticCall(node, 'require', 'cjs');
      } else if (
        ts.isPropertyAccessExpression(expression) &&
        isIdentifierNamed(ts, expression.expression, 'require') &&
        expression.name.text === 'resolve'
      ) {
        addStaticCall(node, 'require.resolve', 'cjs');
      } else if (
        (ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression)) &&
        propertyNameText(ts, expression) === 'require'
      ) {
        const owner = unwrapExpression(ts, expression.expression);
        if (!ts.isIdentifier(owner) || owner.text !== 'module') {
          throw new Error(
            `Unsupported require usage in ${sourceLocation(node)}`,
          );
        }
        addStaticCall(node, 'module.require', 'cjs');
      } else if (
        ts.isIdentifier(expression) &&
        createdRequires.has(expression.text)
      ) {
        addStaticCall(node, 'created require', 'cjs');
      } else if (
        (ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression)) &&
        propertyNameText(ts, expression) === 'resolve' &&
        ts.isIdentifier(unwrapExpression(ts, expression.expression)) &&
        createdRequires.has(unwrapExpression(ts, expression.expression).text)
      ) {
        addStaticCall(node, 'created require.resolve', 'cjs');
      } else if (isCreateRequireFactory(expression)) {
        if (
          !ts.isVariableDeclaration(node.parent) ||
          node.parent.initializer !== node
        ) {
          throw new Error(`Unsupported createRequire usage in ${fileLabel}`);
        }
      } else if (
        (ts.isElementAccessExpression(expression) ||
          ts.isPropertyAccessExpression(expression)) &&
        isIdentifierNamed(ts, expression.expression, 'module') &&
        !allowsAuditedShadowedCommonJsModule &&
        !allowsAuditedBundledRuntime
      ) {
        throw new Error(`Unsupported require usage in ${sourceLocation(node)}`);
      }
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'eval' || node.text === 'Function') {
        if (
          !allowsAuditedBundledRuntime &&
          !isNonValuePropertyName(ts, node) &&
          !isTypeofOperand(node) &&
          !(
            node.text === 'Function' &&
            isDecoratorMetadataFunctionReference(node)
          ) &&
          !(node.text === 'Function' && isInstanceofRightOperand(node)) &&
          !(
            node.text === 'Function' &&
            isFunctionPrototypeToStringCallBase(node)
          ) &&
          !(
            node.text === 'eval' &&
            node.parent &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node &&
            isAuditedLiteralEvalCall(node.parent)
          )
        ) {
          throw new Error(
            `Dynamic code execution is not allowed in ${fileLabel}`,
          );
        }
      }
      if (node.text === 'require') {
        if (
          !isDirectCallTarget(ts, node) &&
          !isRequireResolveBase(ts, node) &&
          !isRequireMainBase(ts, node) &&
          !isTypeofOperand(node) &&
          !isNonValuePropertyName(ts, node)
        ) {
          throw new Error(
            `Unsupported require usage in ${sourceLocation(node)}`,
          );
        }
      }
      if (createdRequires.has(node.text)) {
        if (
          !isBindingIdentifier(ts, node) &&
          !isDirectCallTarget(ts, node) &&
          !isCreatedRequireResolveBase(ts, node, createdRequires)
        ) {
          throw new Error(
            `Unsupported require usage in ${sourceLocation(node)}`,
          );
        }
      }
      if (createRequireFactories.has(node.text)) {
        if (
          !isBindingIdentifier(ts, node) &&
          !isDirectCallTarget(ts, node) &&
          !isNonValuePropertyName(ts, node)
        ) {
          throw new Error(`Unsupported createRequire usage in ${fileLabel}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
};

const findSnapshotEntry = (snapshots, candidate, expectedKind) => {
  const key = pathKey(candidate);
  for (const snapshot of snapshots) {
    const entry = snapshot.byPath.get(key);
    if (entry?.kind === expectedKind) return entry;
  }
  return undefined;
};

const assertRuntimeCandidateInside = (
  runtimeRoots,
  candidate,
  importerLabel,
) => {
  if (!runtimeRoots.some((root) => isWithin(root, candidate))) {
    throw new Error(
      `Relative import escapes runtime roots in ${importerLabel}`,
    );
  }
};

const resolveCommonJsRelative = (
  snapshots,
  runtimeRoots,
  base,
  importerLabel,
  seen = new Set(),
) => {
  assertRuntimeCandidateInside(runtimeRoots, base, importerLabel);
  const cycleKey = pathKey(base);
  if (seen.has(cycleKey)) return undefined;
  seen.add(cycleKey);
  const exact = findSnapshotEntry(snapshots, base, 'file');
  if (exact) return exact;
  for (const extension of ['.js', '.json', '.node']) {
    const candidate = findSnapshotEntry(
      snapshots,
      `${base}${extension}`,
      'file',
    );
    if (candidate) return candidate;
  }
  const directory = findSnapshotEntry(snapshots, base, 'directory');
  if (!directory) return undefined;
  const packageJson = findSnapshotEntry(
    snapshots,
    join(base, 'package.json'),
    'file',
  );
  if (packageJson) {
    const manifest = parseJsonFile(
      readSnapshotEntry(packageJson, `${directory.label}/package.json`),
      `${directory.label}/package.json`,
    );
    if (typeof manifest.main === 'string' && manifest.main.trim()) {
      const mainTarget = resolve(base, manifest.main);
      assertRuntimeCandidateInside(runtimeRoots, mainTarget, importerLabel);
      const resolvedMain = resolveCommonJsRelative(
        snapshots,
        runtimeRoots,
        mainTarget,
        importerLabel,
        seen,
      );
      if (resolvedMain) return resolvedMain;
    }
  }
  for (const extension of ['.js', '.json', '.node']) {
    const indexed = findSnapshotEntry(
      snapshots,
      join(base, `index${extension}`),
      'file',
    );
    if (indexed) return indexed;
  }
  return undefined;
};

const resolveRelativeImport = (context, importer, imported) => {
  const importerPackage = [...context.packageRecords.values()]
    .filter((record) => isWithin(record.root, importer.absolutePath))
    .sort(
      (left, right) =>
        right.root.length - left.root.length ||
        compareUtf8(left.location, right.location),
    )[0];
  const snapshots = importerPackage
    ? [importerPackage.snapshot]
    : context.runtimeSnapshots;
  const roots = importerPackage ? [importerPackage.root] : context.runtimeRoots;
  const base = resolve(dirname(importer.absolutePath), imported.specifier);
  assertRuntimeCandidateInside(roots, base, importer.label);
  const resolved =
    imported.mode === 'esm'
      ? findSnapshotEntry(snapshots, base, 'file')
      : resolveCommonJsRelative(snapshots, roots, base, importer.label);
  if (!resolved) {
    throw new Error(`Missing relative runtime dependency in ${importer.label}`);
  }
  if (extname(resolved.absolutePath).toLocaleLowerCase('en-US') === '.node') {
    throw new Error(`Native addon is not allowed in ${importer.label}`);
  }
  return resolved;
};

const packageRootName = (specifier) => {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
};

const packagePathParts = (name) => name.split('/');

const packageLockLocation = (nodeModulesRoot, packageRoot) => {
  const rel = toUnixPath(relative(nodeModulesRoot, packageRoot));
  return rel ? `node_modules/${rel}` : 'node_modules';
};

const locateInstalledPackage = (context, packageName, importerPackageRoot) => {
  const parts = packagePathParts(packageName);
  const candidates = [];
  if (importerPackageRoot) {
    let current = importerPackageRoot;
    const parentLimit = dirname(context.nodeModulesRoot);
    while (isWithin(parentLimit, current)) {
      candidates.push(join(current, 'node_modules', ...parts));
      if (pathKey(current) === pathKey(parentLimit)) break;
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
  } else {
    candidates.push(join(context.nodeModulesRoot, ...parts));
  }
  const unique = new Set();
  for (const candidate of candidates) {
    const key = pathKey(candidate);
    if (unique.has(key)) continue;
    unique.add(key);
    if (!existsSync(candidate)) continue;
    const inspected = assertStrictPath(
      candidate,
      `node_modules package ${packageName}`,
      'directory',
    );
    if (!isWithin(context.nodeModulesRoot, inspected.canonicalPath)) {
      throw new Error(
        `Runtime dependency escapes node_modules: ${packageName}`,
      );
    }
    return inspected.absolutePath;
  }
  return undefined;
};

const dependencyNamesForManifest = (manifest) => {
  const required = new Map();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    required.set(name, { optional: false, range });
  }
  for (const [name, range] of Object.entries(
    manifest.optionalDependencies ?? {},
  )) {
    required.set(name, { optional: true, range });
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    if (!required.has(name)) required.set(name, { optional, range });
  }
  return [...required.entries()].sort(([left], [right]) =>
    compareUtf8(left, right),
  );
};

const verifyPackageClosure = (context, packageName, importerPackageRoot) => {
  const packageRoot = locateInstalledPackage(
    context,
    packageName,
    importerPackageRoot,
  );
  if (!packageRoot) {
    throw new Error(
      importerPackageRoot
        ? `Missing transitive runtime dependency: ${packageName}`
        : `Missing installed runtime dependency: ${packageName}`,
    );
  }
  const cacheKey = pathKey(packageRoot);
  if (context.packageRecords.has(cacheKey))
    return context.packageRecords.get(cacheKey);

  const location = packageLockLocation(context.nodeModulesRoot, packageRoot);
  context.budget.observePackage(
    context.packageRecords.size + 1,
    location.split('/').length,
  );
  const lockEntry = context.lockManifest.packages?.[location];
  if (!lockEntry || typeof lockEntry !== 'object') {
    throw new Error(`Missing package-lock entry: ${packageName}`);
  }
  if (lockEntry.dev === true) {
    throw new Error(`Development-only package-lock entry: ${packageName}`);
  }
  const packageSnapshot = snapshotTree(packageRoot, location, {
    budget: context.budget,
    frozenTreeFast: context.usesVerifiedDependencyTransition,
    metadataOnlyFiles: context.usesVerifiedDependencyTransition,
    rejectNativeAddons: true,
    skipNodeModules: true,
  });
  const packageJson = packageSnapshot.byPath.get(
    pathKey(join(packageRoot, 'package.json')),
  );
  if (!packageJson || packageJson.kind !== 'file') {
    throw new Error(`Missing installed package manifest: ${packageName}`);
  }
  const manifest = parseJsonFile(
    readSnapshotEntry(packageJson, `${location}/package.json`, context.budget),
    `${location}/package.json`,
  );
  if (
    typeof manifest.version !== 'string' ||
    manifest.version !== String(lockEntry.version ?? '')
  ) {
    throw new Error(`Installed package version drift: ${packageName}`);
  }
  const record = {
    location,
    manifest,
    name: packageName,
    root: packageRoot,
    snapshot: packageSnapshot,
    version: manifest.version,
  };
  context.packageRecords.set(cacheKey, record);
  context.onProgress?.({
    count: context.packageRecords.size,
    fileCount: packageSnapshot.files.length,
    location,
    stage: 'package-snapshot',
  });

  for (const [childName, requirement] of dependencyNamesForManifest(manifest)) {
    const lockRange =
      lockEntry.dependencies?.[childName] ??
      lockEntry.optionalDependencies?.[childName] ??
      lockEntry.peerDependencies?.[childName];
    if (
      lockRange === undefined ||
      String(lockRange) !== String(requirement.range)
    ) {
      throw new Error(`Package-lock dependency drift: ${childName}`);
    }
    const childRoot = locateInstalledPackage(context, childName, packageRoot);
    if (!childRoot && requirement.optional) continue;
    verifyPackageClosure(context, childName, packageRoot);
  }
  return record;
};

const resolveExportsTarget = (
  packageRecord,
  target,
  conditions,
  patternMatch,
) => {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) {
      throw new Error(
        `Unsupported package exports target: ${packageRecord.name}`,
      );
    }
    const expanded =
      patternMatch === undefined
        ? target
        : target.replaceAll('*', patternMatch);
    const segments = expanded.slice(2).split('/');
    if (
      segments.some(
        (segment) =>
          segment === '..' ||
          segment === '.' ||
          segment.toLocaleLowerCase('en-US') === 'node_modules',
      ) ||
      /%2f|%5c/iu.test(expanded)
    ) {
      throw new Error(
        `Package exports target escapes package root: ${packageRecord.name}`,
      );
    }
    const absolutePath = resolve(packageRecord.root, expanded);
    if (!isWithin(packageRecord.root, absolutePath)) {
      throw new Error(
        `Package exports target escapes package root: ${packageRecord.name}`,
      );
    }
    const entry = packageRecord.snapshot.byPath.get(pathKey(absolutePath));
    if (!entry || entry.kind !== 'file') {
      throw new Error(`Missing package exports target: ${packageRecord.name}`);
    }
    return entry;
  }
  if (Array.isArray(target)) {
    if (target.length === 0) {
      throw new Error(
        `Unsupported package exports target: ${packageRecord.name}`,
      );
    }
    let lastError;
    for (const candidate of target) {
      try {
        return resolveExportsTarget(
          packageRecord,
          candidate,
          conditions,
          patternMatch,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw (
      lastError ??
      new Error(`Missing package exports target: ${packageRecord.name}`)
    );
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (conditions.has(condition)) {
        return resolveExportsTarget(
          packageRecord,
          value,
          conditions,
          patternMatch,
        );
      }
    }
    throw new Error(
      `No supported package exports condition: ${packageRecord.name}`,
    );
  }
  throw new Error(`Unsupported package exports target: ${packageRecord.name}`);
};

const selectExportsMapping = (packageRecord, subpath) => {
  const exportsValue = packageRecord.manifest.exports;
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) {
    if (subpath !== '.') {
      throw new Error(`Missing package exports subpath: ${packageRecord.name}`);
    }
    return { patternMatch: undefined, target: exportsValue };
  }
  if (!exportsValue || typeof exportsValue !== 'object') {
    throw new Error(`Unsupported package exports map: ${packageRecord.name}`);
  }
  const keys = Object.keys(exportsValue);
  const hasSubpathKeys = keys.some((key) => key.startsWith('.'));
  const hasConditionKeys = keys.some((key) => !key.startsWith('.'));
  if (hasSubpathKeys && hasConditionKeys) {
    throw new Error(
      `Mixed package exports map is not allowed: ${packageRecord.name}`,
    );
  }
  if (!hasSubpathKeys) {
    if (subpath !== '.') {
      throw new Error(`Missing package exports subpath: ${packageRecord.name}`);
    }
    return { patternMatch: undefined, target: exportsValue };
  }
  if (Object.prototype.hasOwnProperty.call(exportsValue, subpath)) {
    return { patternMatch: undefined, target: exportsValue[subpath] };
  }
  const matches = [];
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      matches.push({
        key,
        match: subpath.slice(prefix.length, subpath.length - suffix.length),
        prefixLength: prefix.length,
        suffixLength: suffix.length,
      });
    }
  }
  matches.sort(
    (left, right) =>
      right.prefixLength - left.prefixLength ||
      right.suffixLength - left.suffixLength ||
      compareUtf8(left.key, right.key),
  );
  if (!matches.length) {
    throw new Error(`Missing package exports subpath: ${packageRecord.name}`);
  }
  return {
    patternMatch: matches[0].match,
    target: exportsValue[matches[0].key],
  };
};

const resolveEsmPackageEntry = (packageRecord, specifier, rootName) => {
  const suffix = specifier.slice(rootName.length);
  const subpath = suffix ? `.${suffix}` : '.';
  if (packageRecord.manifest.exports !== undefined) {
    const mapping = selectExportsMapping(packageRecord, subpath);
    return resolveExportsTarget(
      packageRecord,
      mapping.target,
      new Set(['default', 'import', 'node', 'node-addons']),
      mapping.patternMatch,
    );
  }
  if (subpath !== '.') {
    const entry = packageRecord.snapshot.byPath.get(
      pathKey(resolve(packageRecord.root, subpath.slice(2))),
    );
    if (!entry || entry.kind !== 'file') {
      throw new Error(`Missing installed runtime dependency: ${rootName}`);
    }
    return entry;
  }
  if (
    typeof packageRecord.manifest.main === 'string' &&
    packageRecord.manifest.main.trim()
  ) {
    const entry = resolveCommonJsRelative(
      [packageRecord.snapshot],
      [packageRecord.root],
      resolve(packageRecord.root, packageRecord.manifest.main),
      `package ${rootName}`,
    );
    if (entry) return entry;
  }
  const indexed = packageRecord.snapshot.byPath.get(
    pathKey(join(packageRecord.root, 'index.js')),
  );
  if (!indexed || indexed.kind !== 'file') {
    throw new Error(`Missing installed runtime dependency: ${rootName}`);
  }
  return indexed;
};

const resolveBareImport = (context, importer, imported) => {
  const normalizedBuiltin = imported.specifier.replace(/^node:/u, '');
  if (BUILTINS.has(normalizedBuiltin)) {
    return { descriptor: `builtin\0${normalizedBuiltin}` };
  }
  if (imported.specifier.startsWith('node:')) {
    throw new Error(`Unknown Node builtin in ${importer.label}`);
  }
  if (
    imported.specifier.startsWith('/') ||
    imported.specifier.startsWith('file:') ||
    imported.specifier.startsWith('#')
  ) {
    throw new Error(`Unsupported runtime dependency in ${importer.label}`);
  }
  const rootName = packageRootName(imported.specifier);
  const importerPackage = [...context.packageRecords.values()]
    .filter((record) => isWithin(record.root, importer.absolutePath))
    .sort(
      (left, right) =>
        right.root.length - left.root.length ||
        compareUtf8(left.location, right.location),
    )[0];
  let rootPackage;
  if (importerPackage) {
    const declaredDependencies = Object.fromEntries(
      dependencyNamesForManifest(importerPackage.manifest),
    );
    if (
      rootName !== importerPackage.manifest.name &&
      !Object.prototype.hasOwnProperty.call(declaredDependencies, rootName)
    ) {
      throw new Error(
        `Undeclared package runtime dependency in ${importer.label}`,
      );
    }
    rootPackage =
      rootName === importerPackage.manifest.name
        ? importerPackage
        : verifyPackageClosure(context, rootName, importerPackage.root);
  } else {
    if (!Object.prototype.hasOwnProperty.call(context.dependencies, rootName)) {
      if (
        Object.prototype.hasOwnProperty.call(context.devDependencies, rootName)
      ) {
        throw new Error(`Development-only runtime dependency: ${rootName}`);
      }
      throw new Error(`Undeclared runtime dependency: ${rootName}`);
    }
    if (
      context.rootLockDependencies[rootName] !== context.dependencies[rootName]
    ) {
      throw new Error(`Root package-lock dependency drift: ${rootName}`);
    }
    rootPackage = verifyPackageClosure(context, rootName, undefined);
  }
  const cacheKey = `${importerPackage?.location ?? '<root>'}\0${imported.mode}\0${imported.specifier}`;
  const cached = context.bareResolutionCache.get(cacheKey);
  if (cached) return cached;
  let entry;
  if (imported.mode === 'esm') {
    entry = resolveEsmPackageEntry(rootPackage, imported.specifier, rootName);
  } else {
    let resolvedEntry;
    try {
      const resolutionBase = importerPackage
        ? importer.absolutePath
        : join(dirname(context.nodeModulesRoot), 'package.json');
      resolvedEntry = createRequire(resolutionBase).resolve(imported.specifier);
    } catch {
      throw new Error(`Missing installed runtime dependency: ${rootName}`);
    }
    const resolved = assertStrictPath(
      resolvedEntry,
      `runtime entry for ${rootName}`,
      'file',
    );
    if (!isWithin(rootPackage.root, resolved.canonicalPath)) {
      throw new Error(`Runtime dependency escapes package root: ${rootName}`);
    }
    entry = rootPackage.snapshot.byPath.get(pathKey(resolved.absolutePath));
    if (!entry || entry.kind !== 'file') {
      throw new Error(
        `Runtime entry is outside verified package tree: ${rootName}`,
      );
    }
  }
  if (extname(entry.absolutePath).toLocaleLowerCase('en-US') === '.node') {
    throw new Error(`Native addon is not allowed: ${rootName}`);
  }
  const verifiedEntry = readSnapshotEntry(
    entry,
    `${rootPackage.location}/${toUnixPath(
      relative(rootPackage.root, entry.absolutePath),
    )}`,
    context.budget,
  );
  const descriptor = `package\0${rootName}\0${rootPackage.version}\0${toUnixPath(
    relative(rootPackage.root, entry.absolutePath),
  )}\0${verifiedEntry.hash}`;
  const result = {
    descriptor,
    entry: { ...entry, hash: verifiedEntry.hash, size: verifiedEntry.size },
    packageRecord: rootPackage,
  };
  context.bareResolutionCache.set(cacheKey, result);
  return result;
};

const parseArguments = (arguments_) => {
  const names = new Map([
    ['--server-root', 'serverRoot'],
    ['--shared-root', 'sharedRoot'],
    ['--package', 'packagePath'],
    ['--lock', 'lockPath'],
    ['--node-modules-root', 'nodeModulesRoot'],
    ['--expected-build-fingerprint', 'expectedBuildFingerprint'],
    ['--json-output', 'jsonOutputPath'],
    ['--verified-dependency-transition', 'verifiedDependencyTransition'],
    [
      '--verified-lock-physical-tree-fingerprint',
      'verifiedLockPhysicalTreeFingerprint',
    ],
    [
      '--verified-installed-physical-tree-fingerprint',
      'verifiedInstalledPhysicalTreeFingerprint',
    ],
  ]);
  const required = new Set([
    'serverRoot',
    'sharedRoot',
    'packagePath',
    'lockPath',
    'nodeModulesRoot',
    'expectedBuildFingerprint',
  ]);
  const options = {};
  try {
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (argument === '--json') continue;
      const property = names.get(argument);
      const value = arguments_[index + 1];
      if (
        !property ||
        property in options ||
        !value ||
        value.startsWith('--')
      ) {
        throw new Error('invalid');
      }
      options[property] = value;
      index += 1;
    }
    if ([...required].some((name) => !(name in options))) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('Invalid command arguments');
  }
  return options;
};

const assertSnapshotUnchanged = (previous, current, label) => {
  if (previous.digest !== current.digest) {
    throw new Error(`Concurrent mutation detected in ${label}`);
  }
};

// Packager/verifier contract: hash every dist/server and dist/shared file as
// root label + relative path + byte length + file SHA256, then hash the sorted
// UTF-8 entries. The packager computes the same value independently.
const computeRuntimeBuildFingerprint = (runtimeSnapshots) =>
  sha256(
    runtimeSnapshots
      .flatMap((snapshot) =>
        snapshot.files.map(
          (file) =>
            `${snapshot.rootLabel}\0${file.relativePath}\0${file.size}\0${file.hash}`,
        ),
      )
      .sort(compareUtf8)
      .join('\n'),
  );

export const verifyProductionRuntimeClosure = ({
  serverRoot,
  sharedRoot,
  packagePath,
  lockPath,
  nodeModulesRoot,
  onProgress,
  limits,
  expectedBuildFingerprint,
  verifiedDependencyTransition,
  verifiedLockPhysicalTreeFingerprint,
  verifiedInstalledPhysicalTreeFingerprint,
}) => {
  const budget = createResourceBudget(limits);
  const reportProgress = (event) => {
    budget.checkDeadline();
    if (typeof onProgress === 'function') onProgress(event);
    budget.checkDeadline();
  };
  if (
    !serverRoot ||
    !sharedRoot ||
    !packagePath ||
    !lockPath ||
    !nodeModulesRoot
  ) {
    throw new Error('Explicit runtime closure paths are required');
  }
  const verifiedProofPartCount = [
    verifiedDependencyTransition,
    verifiedLockPhysicalTreeFingerprint,
    verifiedInstalledPhysicalTreeFingerprint,
  ].filter((value) => value !== undefined).length;
  if (verifiedProofPartCount !== 0 && verifiedProofPartCount !== 3) {
    throw new Error('Verified dependency transition proof is incomplete');
  }
  const usesVerifiedDependencyTransition = verifiedProofPartCount === 3;
  if (
    usesVerifiedDependencyTransition &&
    (!['none', 'runtime-root-declarations-only'].includes(
      verifiedDependencyTransition,
    ) ||
      !/^[0-9a-f]{64}$/u.test(verifiedLockPhysicalTreeFingerprint) ||
      !/^[0-9a-f]{64}$/u.test(verifiedInstalledPhysicalTreeFingerprint))
  ) {
    throw new Error('Verified dependency transition proof is invalid');
  }
  const { file: packageFile, value: packageManifest } = readStableJsonFile(
    packagePath,
    'package.json',
    { budget },
  );
  const { file: lockFile, value: lockManifest } = readStableJsonFile(
    lockPath,
    'package-lock.json',
    { budget },
  );
  if (
    ![2, 3].includes(lockManifest.lockfileVersion) ||
    !lockManifest.packages
  ) {
    throw new Error('Unsupported package-lock format');
  }
  const rootLock = lockManifest.packages[''];
  if (!rootLock || typeof rootLock !== 'object') {
    throw new Error('Missing package-lock root entry');
  }
  const inspectedNodeModules = assertStrictPath(
    nodeModulesRoot,
    'node_modules',
    'directory',
  );
  const runtimeSnapshots = [
    snapshotTree(serverRoot, 'dist/server', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
    snapshotTree(sharedRoot, 'dist/shared', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
  ];
  const buildFingerprint = computeRuntimeBuildFingerprint(runtimeSnapshots);
  reportProgress({ stage: 'runtime-snapshot' });
  for (const snapshot of runtimeSnapshots) {
    if (snapshot.files.length === 0) {
      throw new Error(`${snapshot.rootLabel} must contain runtime files`);
    }
  }
  const mainEntry = runtimeSnapshots[0].byPath.get(
    pathKey(join(runtimeSnapshots[0].root, 'main.js')),
  );
  if (!mainEntry || mainEntry.kind !== 'file') {
    throw new Error('Missing dist/server/main.js');
  }
  if (mainEntry.size === 0)
    throw new Error('dist/server/main.js must not be empty');
  if (
    assertValidJavaScript(
      readSnapshotEntry(mainEntry, mainEntry.label, budget).buffer.toString(
        'utf8',
      ),
      mainEntry.label,
    ).body.length === 0
  ) {
    throw new Error('dist/server/main.js must contain executable JavaScript');
  }

  const runtimeRoots = runtimeSnapshots.map((snapshot) => snapshot.root);
  const context = {
    bareResolutionCache: new Map(),
    budget,
    dependencies: {
      ...(packageManifest.dependencies ?? {}),
      ...(packageManifest.optionalDependencies ?? {}),
    },
    devDependencies: packageManifest.devDependencies ?? {},
    lockManifest,
    nodeModulesRoot: inspectedNodeModules.absolutePath,
    packagePath: packageFile.absolutePath,
    packageRecords: new Map(),
    onProgress: reportProgress,
    rootLockDependencies: {
      ...(rootLock.dependencies ?? {}),
      ...(rootLock.optionalDependencies ?? {}),
    },
    runtimeRoots,
    runtimeSnapshots,
    usesVerifiedDependencyTransition,
    verifiedInstalledPhysicalTreeFingerprint,
    verifiedLockPhysicalTreeFingerprint,
  };

  const scanQueue = runtimeSnapshots
    .flatMap((snapshot) => snapshot.files)
    .filter((file) =>
      JAVASCRIPT_EXTENSIONS.has(extname(file.absolutePath).toLowerCase()),
    )
    .sort((left, right) => compareUtf8(left.label, right.label));
  const queued = new Set(scanQueue.map((file) => pathKey(file.absolutePath)));
  const scanned = new Set();
  const fingerprintEntries = runtimeSnapshots.flatMap((snapshot) =>
    snapshot.files.map(
      (file) => `runtime\0${file.label}\0${file.size}\0${file.hash}`,
    ),
  );
  const thirdPartyAstMode = usesVerifiedDependencyTransition
    ? 'locked-physical-tree'
    : 'deep';
  fingerprintEntries.push(`third-party-ast-mode\0${thirdPartyAstMode}`);
  if (usesVerifiedDependencyTransition) {
    fingerprintEntries.push(
      `verified-lock-physical-tree\0${verifiedLockPhysicalTreeFingerprint}`,
      `verified-installed-physical-tree\0${verifiedInstalledPhysicalTreeFingerprint}`,
      `verified-dependency-transition\0${verifiedDependencyTransition}`,
    );
  }
  const bareImports = [];
  let buildFingerprintVerified = false;
  let importCount = 0;
  while (scanQueue.length || bareImports.length) {
    budget.checkDeadline();
    while (scanQueue.length) {
      budget.checkDeadline();
      const file = scanQueue.shift();
      const key = pathKey(file.absolutePath);
      if (scanned.has(key)) continue;
      scanned.add(key);
      const imports = scanImports(
        readSnapshotEntry(file, file.label, budget).buffer.toString('utf8'),
        file.label,
      );
      for (const imported of imports) {
        importCount += 1;
        budget.observeImport(importCount);
        if (!imported.specifier) {
          throw new Error(`Empty runtime dependency in ${file.label}`);
        }
        if (isAbsolute(imported.specifier)) {
          throw new Error(
            `Absolute runtime dependency is not allowed in ${file.label}`,
          );
        }
        if (imported.specifier.startsWith('.')) {
          const target = resolveRelativeImport(context, file, imported);
          const resolution = `relative\0${target.label}\0${target.hash}`;
          const extension = extname(target.absolutePath).toLowerCase();
          if (
            extension !== '.json' &&
            !queued.has(pathKey(target.absolutePath))
          ) {
            queued.add(pathKey(target.absolutePath));
            scanQueue.push(target);
          }
          fingerprintEntries.push(
            `import\0${file.label}\0${imported.kind}\0${imported.specifier}\0${resolution}`,
          );
        } else {
          bareImports.push({ file, imported });
        }
      }
    }
    if (!buildFingerprintVerified) {
      if (
        typeof expectedBuildFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(expectedBuildFingerprint)
      ) {
        throw new Error('Expected runtime build fingerprint is required');
      }
      if (buildFingerprint !== expectedBuildFingerprint) {
        throw new Error('Runtime build fingerprint mismatch');
      }
      fingerprintEntries.push(`runtime-build-fingerprint\0${buildFingerprint}`);
      buildFingerprintVerified = true;
    }
    if (bareImports.length) {
      const { file, imported } = bareImports.shift();
      const resolution = resolveBareImport(context, file, imported);
      fingerprintEntries.push(
        `import\0${file.label}\0${imported.kind}\0${imported.specifier}\0${resolution.descriptor}`,
      );
      if (
        !usesVerifiedDependencyTransition &&
        resolution.entry &&
        JAVASCRIPT_EXTENSIONS.has(
          extname(resolution.entry.absolutePath).toLowerCase(),
        ) &&
        !queued.has(pathKey(resolution.entry.absolutePath))
      ) {
        queued.add(pathKey(resolution.entry.absolutePath));
        scanQueue.push(resolution.entry);
      }
    }
  }
  reportProgress({ count: scanned.size, stage: 'runtime-ast-scan' });
  reportProgress({
    count: context.packageRecords.size,
    stage: 'runtime-import-scan',
  });

  for (const record of context.packageRecords.values()) {
    fingerprintEntries.push(
      `package\0${record.location}\0${record.version}\0${record.snapshot.digest}`,
    );
  }
  fingerprintEntries.push(`package-json\0${packageFile.hash}`);
  fingerprintEntries.push(`package-lock\0${lockFile.hash}`);

  const allInitialPaths = [
    packageFile.absolutePath,
    lockFile.absolutePath,
    inspectedNodeModules.absolutePath,
    ...runtimeSnapshots.flatMap((snapshot) => [
      snapshot.root,
      ...snapshot.entries.map((entry) => entry.absolutePath),
    ]),
    ...[...context.packageRecords.values()].flatMap((record) => [
      record.root,
      ...record.snapshot.entries.map((entry) => entry.absolutePath),
    ]),
  ];
  const finalPackage = readStableFile(packagePath, 'package.json', { budget });
  const finalLock = readStableFile(lockPath, 'package-lock.json', { budget });
  if (
    finalPackage.hash !== packageFile.hash ||
    finalLock.hash !== lockFile.hash
  ) {
    throw new Error('Concurrent mutation detected in dependency manifests');
  }
  const finalRuntimeSnapshots = [
    snapshotTree(serverRoot, 'dist/server', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
    snapshotTree(sharedRoot, 'dist/shared', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
  ];
  for (let index = 0; index < runtimeSnapshots.length; index += 1) {
    assertSnapshotUnchanged(
      runtimeSnapshots[index],
      finalRuntimeSnapshots[index],
      runtimeSnapshots[index].rootLabel,
    );
  }
  for (const record of context.packageRecords.values()) {
    if (usesVerifiedDependencyTransition) break;
    const finalSnapshot = snapshotTree(record.root, record.location, {
      budget,
      rejectNativeAddons: true,
      skipNodeModules: true,
    });
    assertSnapshotUnchanged(record.snapshot, finalSnapshot, record.location);
  }
  assertNoAlternateDataStreams(allInitialPaths, budget);
  reportProgress({ stage: 'ads-scan' });
  reportProgress({ stage: 'final-integrity-check' });

  const terminalPackage = readStableFile(packagePath, 'package.json', {
    budget,
  });
  const terminalLock = readStableFile(lockPath, 'package-lock.json', {
    budget,
  });
  if (
    terminalPackage.hash !== packageFile.hash ||
    terminalLock.hash !== lockFile.hash
  ) {
    throw new Error('Concurrent mutation detected in dependency manifests');
  }
  const terminalRuntimeSnapshots = [
    snapshotTree(serverRoot, 'dist/server', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
    snapshotTree(sharedRoot, 'dist/shared', {
      budget,
      rejectMaps: true,
      rejectNativeAddons: true,
    }),
  ];
  for (let index = 0; index < runtimeSnapshots.length; index += 1) {
    assertSnapshotUnchanged(
      runtimeSnapshots[index],
      terminalRuntimeSnapshots[index],
      runtimeSnapshots[index].rootLabel,
    );
  }
  for (const record of context.packageRecords.values()) {
    if (usesVerifiedDependencyTransition) break;
    const terminalSnapshot = snapshotTree(record.root, record.location, {
      budget,
      rejectNativeAddons: true,
      skipNodeModules: true,
    });
    assertSnapshotUnchanged(record.snapshot, terminalSnapshot, record.location);
  }
  assertNoAlternateDataStreams(allInitialPaths, budget);
  fingerprintEntries.sort(compareUtf8);
  return {
    success: true,
    buildFingerprint,
    dependencyMode: usesVerifiedDependencyTransition
      ? 'verified-transition'
      : 'full-audit',
    thirdPartyAstMode,
    fileCount: scanned.size,
    importCount,
    runtimeClosureFingerprint: sha256(fingerprintEntries.join('\n')),
    ...(usesVerifiedDependencyTransition
      ? {
          verifiedInstalledPhysicalTreeFingerprint,
          verifiedLockPhysicalTreeFingerprint,
          verifiedDependencyTransition,
        }
      : {}),
  };
};

const sanitizeCliError = (error) => {
  let message = error instanceof Error ? error.message : 'Verification failed';
  message = String(message)
    .replace(/[\r\n\t\u2028\u2029]+/gu, ' ')
    .trim();
  const offsets = [message.search(/[A-Za-z]:[\\/]/u)];
  const uncOffset = message.indexOf('\\\\');
  if (uncOffset >= 0) offsets.push(uncOffset);
  if (message.startsWith('/')) {
    offsets.push(0);
  } else {
    const posixMatch = /[\s(]\/[^/\s]/u.exec(message);
    if (posixMatch?.index !== undefined) offsets.push(posixMatch.index + 1);
  }
  const absolutePathOffset = offsets
    .filter((offset) => offset >= 0)
    .sort((left, right) => left - right)[0];
  if (absolutePathOffset !== undefined) {
    const prefix = message.slice(0, absolutePathOffset).trimEnd();
    message = prefix ? `${prefix} <path>` : '<path>';
  }
  return message.slice(0, 512) || 'Verification failed';
};

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      pathKey(nativeRealpath(process.argv[1])) ===
      pathKey(nativeRealpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
})();

const emitCliReport = (report, outputPath) => {
  const payload = `${JSON.stringify(report)}\n`;
  if (!outputPath) {
    process.stdout.write(payload);
    return;
  }
  if (!isAbsolute(outputPath)) {
    throw new Error('JSON output path must be absolute');
  }
  writeFileSync(resolve(outputPath), payload, {
    encoding: 'utf8',
    flag: 'wx',
    flush: true,
  });
};

if (isDirectExecution) {
  let jsonOutputPath;
  try {
    const options = parseArguments(process.argv.slice(2));
    jsonOutputPath = options.jsonOutputPath;
    const report = verifyProductionRuntimeClosure(options);
    emitCliReport(report, jsonOutputPath);
  } catch (error) {
    const message = sanitizeCliError(error);
    try {
      emitCliReport({ success: false, error: message }, jsonOutputPath);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ success: false, error: message })}\n`,
      );
    }
    process.exitCode = 1;
  }
}
