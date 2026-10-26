import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const IDENTIFIER = '[$A-Z_a-z][$0-9A-Z_a-z]*';
const HASH = '[0-9a-f]{8,64}';
const ordinalCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const parseArguments = (arguments_) => {
  let root;
  let json = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--root') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a directory path');
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!root) {
    throw new Error('--root is required');
  }

  return { json, root };
};

const escapeRegularExpression = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseChunkMap = (body, extension) => {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return [];
  }

  const assets = [];
  const chunkIds = new Set();
  for (const rawEntry of trimmedBody.split(',')) {
    const entry = rawEntry.trim();
    const match = entry.match(
      new RegExp(`^(?:"(\\d+)"|(\\d+))\\s*:\\s*"(${HASH})"$`),
    );
    if (!match) {
      throw new Error(`Unsupported ${extension} chunk map entry: ${entry}`);
    }

    const chunkId = match[1] ?? match[2];
    if (chunkIds.has(chunkId)) {
      throw new Error(`Duplicate ${extension} chunk id: ${chunkId}`);
    }
    chunkIds.add(chunkId);
    assets.push(`chunks/${chunkId}.${match[3]}.${extension}`);
  }

  return assets;
};

const findRuntimeVariable = (source) => {
  const matches = [
    ...source.matchAll(
      new RegExp(`(${IDENTIFIER})\\.u\\s*=\\s*(${IDENTIFIER})\\s*=>`, 'g'),
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Webpack JavaScript chunk runtime, found ${matches.length}`,
    );
  }
  return matches[0][1];
};

const extractJavaScriptAssets = (source, runtimeVariable) => {
  const runtime = escapeRegularExpression(runtimeVariable);
  const match = source.match(
    new RegExp(
      `${runtime}\\.u\\s*=\\s*(${IDENTIFIER})\\s*=>\\s*"chunks/"\\s*\\+\\s*\\1\\s*\\+\\s*"\\."\\s*\\+\\s*\\(\\{([\\s\\S]*?)\\}\\)\\[\\1\\]\\s*\\+\\s*"\\.js"`,
    ),
  );
  if (!match) {
    throw new Error('Unsupported Webpack JavaScript chunk runtime mapping');
  }
  return parseChunkMap(match[2], 'js');
};

const extractCssAssets = (source, runtimeVariable) => {
  const runtime = escapeRegularExpression(runtimeVariable);
  const match = source.match(
    new RegExp(
      `${runtime}\\.k\\s*=\\s*(${IDENTIFIER})\\s*=>[\\s\\S]{0,300}?"main\\.css"[\\s\\S]{0,300}?"chunks/"\\s*\\+\\s*\\1\\s*\\+\\s*"\\."\\s*\\+\\s*\\(\\{([\\s\\S]*?)\\}\\)\\[\\1\\]\\s*\\+\\s*"\\.css"`,
    ),
  );
  if (!match) {
    throw new Error('Unsupported Webpack CSS chunk runtime mapping');
  }
  return parseChunkMap(match[2], 'css');
};

const assertIndexEntrypoints = (source) => {
  const hasMainJavaScript =
    /\bsrc\s*=\s*["']\/main\.js(?:[?#][^"']*)?["']/i.test(source);
  const hasMainCss =
    /\bhref\s*=\s*["']\/main\.css(?:[?#][^"']*)?["']/i.test(source);

  if (!hasMainJavaScript || !hasMainCss) {
    const missing = [];
    if (!hasMainJavaScript) missing.push('/main.js');
    if (!hasMainCss) missing.push('/main.css');
    throw new Error(`Missing index entrypoints: ${missing.join(', ')}`);
  }
};

const isNonemptyFile = (filePath) => {
  if (!existsSync(filePath)) return false;
  const stats = statSync(filePath);
  return stats.isFile() && stats.size > 0;
};

const listStaticAssets = (root) => {
  const assets = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      const relativePath = relative(root, fullPath).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Client asset graph contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (relativePath === 'chunks') continue;
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Client asset graph contains an unsupported entry: ${relativePath}`);
      }
      assets.push(relativePath);
    }
  };
  visit(root);
  return assets.sort(ordinalCompare);
};

const verifyAssetGraph = (root) => {
  const indexPath = resolve(root, 'index.html');
  const mainPath = resolve(root, 'main.js');

  if (!isNonemptyFile(indexPath)) {
    throw new Error('Missing client entrypoint: index.html');
  }
  if (!isNonemptyFile(mainPath)) {
    throw new Error('Missing client entrypoint: main.js');
  }

  const indexSource = readFileSync(indexPath, 'utf8');
  const mainSource = readFileSync(mainPath, 'utf8');
  assertIndexEntrypoints(indexSource);

  const runtimeVariable = findRuntimeVariable(mainSource);
  const cssAssets = extractCssAssets(mainSource, runtimeVariable);
  const graphAssets = [
    'main.js',
    'main.css',
    ...extractJavaScriptAssets(mainSource, runtimeVariable),
    ...cssAssets,
  ];
  const hasMainLegacyCss = isNonemptyFile(resolve(root, 'main.legacy.css'));
  if (hasMainLegacyCss) {
    graphAssets.push('main.legacy.css');
  }
  for (const cssAsset of cssAssets) {
    const legacyAsset = cssAsset.replace(/\.css$/u, '.legacy.css');
    if (hasMainLegacyCss || isNonemptyFile(resolve(root, legacyAsset))) {
      graphAssets.push(legacyAsset);
    }
  }
  if (new Set(graphAssets).size !== graphAssets.length) {
    throw new Error('Duplicate client asset paths in runtime mapping');
  }

  const activeStaticAssets = listStaticAssets(root);
  const expectedAssets = [
    ...activeStaticAssets,
    ...graphAssets
      .filter((asset) => asset.startsWith('chunks/'))
      .sort(ordinalCompare),
  ];
  if (new Set(expectedAssets).size !== expectedAssets.length) {
    throw new Error('Duplicate client asset paths in active closure');
  }

  const missingAssets = expectedAssets.filter(
    (asset) => !isNonemptyFile(resolve(root, asset)),
  );

  return {
    ok: missingAssets.length === 0,
    runtimeVariable,
    expectedAssets,
    activeStaticAssets,
    activeChunkAssets: expectedAssets.filter((asset) =>
      asset.startsWith('chunks/'),
    ),
    missingAssets,
  };
};

let outputAsJson = process.argv.includes('--json');

try {
  const options = parseArguments(process.argv.slice(2));
  outputAsJson = options.json;
  const report = verifyAssetGraph(options.root);

  if (outputAsJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (report.ok) {
    process.stdout.write(
      `Client asset graph is complete (${report.expectedAssets.length} assets).\n`,
    );
  }

  if (!report.ok) {
    process.stderr.write(
      `Missing client assets: ${report.missingAssets.join(', ')}\n`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (outputAsJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  }
  process.stderr.write(`Client asset graph verification failed: ${message}\n`);
  process.exitCode = 1;
}
