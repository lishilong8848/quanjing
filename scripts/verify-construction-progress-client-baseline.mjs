#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { minify } from 'terser';

const allowedChangedJavaScript = ['chunks/3668.js'];
const allowedAddedCssRules = {
  'main.css': [
    '@layer utilities|@media (min-width:64rem)|.lg\\:flex{display:flex}',
  ],
  'main.legacy.css': [
    '@media (min-width:64rem)|.lg\\:flex{display:flex}',
  ],
};
const requiredConstructionMarkers = [
  '每日施工进展',
  '当天开工前完成人员核查',
  '完成进度',
];

const walkFiles = (root, current = root, files = []) => {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported client entry: ${fullPath}`);
    }
    files.push(path.relative(root, fullPath).replaceAll('\\', '/'));
  }
  return files;
};

const logicalAssetPath = (relativePath) =>
  relativePath.replace(
    /^(chunks\/\d+)\.[0-9a-f]{8}((?:\.legacy)?\.(?:js|css))$/,
    '$1$2',
  );

const buildAssetMap = (root) => {
  const map = new Map();
  for (const relativePath of walkFiles(root)) {
    const logicalPath = logicalAssetPath(relativePath);
    if (map.has(logicalPath)) {
      throw new Error(`Duplicate logical client asset: ${logicalPath}`);
    }
    map.set(logicalPath, relativePath);
  }
  return map;
};

const normalizeBuildNoise = (logicalPath, source) => {
  let normalized = source
    .replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
      '<BUILD_TIME>',
    )
    .replace(
      /\.[0-9a-f]{8}(?=(?:\.legacy)?\.(?:js|css))/g,
      '.<ASSET_HASH>',
    );
  if (logicalPath === 'main.js') {
    normalized = normalized.replace(
      /:"[0-9a-f]{8}"/g,
      ':"<ASSET_HASH>"',
    );
  }
  if (logicalPath === 'main.js' || logicalPath === 'polyfills.js') {
    normalized = normalized.replace(
      /\.h=\(\)=>"[0-9a-f]{16}"/g,
      '.h=()=>"<BUILD_HASH>"',
    );
  }
  return normalized;
};

const canonicalizeJavaScript = async (logicalPath, source) => {
  const result = await minify(normalizeBuildNoise(logicalPath, source), {
    compress: false,
    mangle: { toplevel: true },
    format: { comments: false },
  });
  if (result.error || typeof result.code !== 'string') {
    throw result.error ?? new Error(`Unable to normalize ${logicalPath}`);
  }
  return result.code;
};

const canonicalCssRule = (rule) => {
  const parents = [];
  for (
    let parent = rule.parent;
    parent && parent.type !== 'root';
    parent = parent.parent
  ) {
    if (parent.type === 'atrule') {
      parents.unshift(`@${parent.name} ${parent.params}`);
    }
  }
  const body = (rule.nodes ?? []).map((node) => node.toString()).join(';');
  return `${parents.join('|')}|${rule.selector}{${body}}`;
};

const collectCssRules = (source) => {
  const rules = new Set();
  postcss.parse(source).walkRules((rule) => {
    rules.add(canonicalCssRule(rule));
  });
  return rules;
};

const setDifference = (left, right) =>
  [...left].filter((value) => !right.has(value)).sort();

const assertSameLogicalAssets = (
  baselineAssets,
  currentAssets,
  expectedCount,
) => {
  if (
    baselineAssets.size !== expectedCount ||
    currentAssets.size !== expectedCount
  ) {
    throw new Error(
      `Expected ${expectedCount} client files; baseline has ` +
        `${baselineAssets.size} and current has ${currentAssets.size}.`,
    );
  }
  const baselineKeys = [...baselineAssets.keys()].sort();
  const currentKeys = [...currentAssets.keys()].sort();
  if (JSON.stringify(baselineKeys) !== JSON.stringify(currentKeys)) {
    throw new Error('Current client logical asset set differs from baseline.');
  }
};

const assertExactList = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch. Expected ${JSON.stringify(expected)}, got ` +
        `${JSON.stringify(actual)}.`,
    );
  }
};

export const verifyClientBaseline = async ({
  baselineDir,
  currentDir,
  expectedCount = 88,
}) => {
  const baselineRoot = path.resolve(baselineDir);
  const currentRoot = path.resolve(currentDir);
  if (!fs.statSync(baselineRoot).isDirectory()) {
    throw new Error(`Baseline client directory is missing: ${baselineRoot}`);
  }
  if (!fs.statSync(currentRoot).isDirectory()) {
    throw new Error(`Current client directory is missing: ${currentRoot}`);
  }

  const baselineAssets = buildAssetMap(baselineRoot);
  const currentAssets = buildAssetMap(currentRoot);
  assertSameLogicalAssets(
    baselineAssets,
    currentAssets,
    expectedCount,
  );

  const changedJavaScript = [];
  const addedCssRules = {};
  const removedCssRules = {};
  for (const logicalPath of [...baselineAssets.keys()].sort()) {
    const baselinePath = path.join(
      baselineRoot,
      baselineAssets.get(logicalPath),
    );
    const currentPath = path.join(
      currentRoot,
      currentAssets.get(logicalPath),
    );
    const baselineBuffer = fs.readFileSync(baselinePath);
    const currentBuffer = fs.readFileSync(currentPath);

    if (logicalPath.endsWith('.js')) {
      const baselineSource = baselineBuffer.toString('utf8');
      const currentSource = currentBuffer.toString('utf8');
      const baselineNoiseNormalized = normalizeBuildNoise(
        logicalPath,
        baselineSource,
      );
      const currentNoiseNormalized = normalizeBuildNoise(
        logicalPath,
        currentSource,
      );
      if (baselineNoiseNormalized === currentNoiseNormalized) {
        continue;
      }
      const [baselineCanonical, currentCanonical] = await Promise.all([
        canonicalizeJavaScript(logicalPath, baselineSource),
        canonicalizeJavaScript(logicalPath, currentSource),
      ]);
      if (baselineCanonical !== currentCanonical) {
        changedJavaScript.push(logicalPath);
      }
      continue;
    }

    if (logicalPath.endsWith('.css')) {
      const baselineRules = collectCssRules(
        baselineBuffer.toString('utf8'),
      );
      const currentRules = collectCssRules(currentBuffer.toString('utf8'));
      const added = setDifference(currentRules, baselineRules);
      const removed = setDifference(baselineRules, currentRules);
      if (added.length > 0) {
        addedCssRules[logicalPath] = added;
      }
      if (removed.length > 0) {
        removedCssRules[logicalPath] = removed;
      }
      continue;
    }

    if (!baselineBuffer.equals(currentBuffer)) {
      throw new Error(`Unexpected changed client asset: ${logicalPath}`);
    }
  }

  assertExactList(
    changedJavaScript,
    allowedChangedJavaScript,
    'Changed JavaScript assets',
  );
  assertExactList(
    Object.keys(removedCssRules).sort(),
    [],
    'CSS files with removed rules',
  );
  assertExactList(
    Object.keys(addedCssRules).sort(),
    Object.keys(allowedAddedCssRules).sort(),
    'CSS files with added rules',
  );
  for (const [logicalPath, expectedRules] of Object.entries(
    allowedAddedCssRules,
  )) {
    assertExactList(
      addedCssRules[logicalPath],
      expectedRules,
      `Added CSS rules in ${logicalPath}`,
    );
  }

  const constructionPath = path.join(
    currentRoot,
    currentAssets.get('chunks/3668.js'),
  );
  const constructionSource = fs.readFileSync(constructionPath, 'utf8');
  for (const marker of requiredConstructionMarkers) {
    if (!constructionSource.includes(marker)) {
      throw new Error(
        `Construction client chunk is missing marker: ${marker}`,
      );
    }
  }

  return {
    clientFileCount: currentAssets.size,
    changedJavaScript,
    addedCssRules,
    removedCssRules,
  };
};

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const [, , baselineDir, currentDir, ...options] = process.argv;
  const expectedOption = options.find((value) =>
    value.startsWith('--expected-count='),
  );
  const expectedCount = expectedOption
    ? Number(expectedOption.split('=')[1])
    : 88;
  if (
    !baselineDir ||
    !currentDir ||
    !Number.isInteger(expectedCount) ||
    expectedCount <= 0
  ) {
    console.error(
      'Usage: node verify-construction-progress-client-baseline.mjs ' +
        '<baseline-client-dir> <current-client-dir> ' +
        '[--expected-count=88]',
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await verifyClientBaseline({
        baselineDir,
        currentDir,
        expectedCount,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
