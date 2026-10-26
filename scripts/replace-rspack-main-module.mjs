import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Script } from 'node:vm';

const requiredOptions = [
  'baseline',
  'current',
  'output',
  'module-id',
  'chunk-id',
  'baseline-chunk-hash',
  'current-chunk-hash',
];

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const rawName = argv[index];
    const value = argv[index + 1];
    if (!rawName?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${rawName ?? '<end>'}`);
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate option: --${name}`);
    }
    options.set(name, value);
  }
  for (const name of requiredOptions) {
    if (!options.get(name)) {
      throw new Error(`Missing required option: --${name}`);
    }
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function assertIdentifier(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must contain digits only`);
  }
}

function assertChunkHash(value, label) {
  if (!/^[a-f0-9]{8,64}$/i.test(value)) {
    throw new Error(`${label} must be an 8-64 character hexadecimal hash`);
  }
}

function assertExpectedHash(actual, expected, label) {
  if (expected === undefined) {
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error(`${label} expected SHA256 is invalid`);
  }
  if (actual !== expected.toUpperCase()) {
    throw new Error(
      `${label} SHA256 mismatch. Expected ${expected.toUpperCase()}, got ${actual}.`,
    );
  }
}

function previousNonWhitespace(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) {
      return source[cursor];
    }
  }
  return '';
}

function nextNonWhitespaceIndex(source, index) {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipQuoted(source, start, quote) {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) {
      return cursor + 1;
    }
  }
  throw new Error(`Unterminated ${quote} string while scanning main.js`);
}

function skipLineComment(source, start) {
  const end = source.indexOf('\n', start + 2);
  return end < 0 ? source.length : end + 1;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  if (end < 0) {
    throw new Error('Unterminated block comment while scanning main.js');
  }
  return end + 2;
}

function skipRegex(source, start) {
  let inCharacterClass = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (character === '/' && !inCharacterClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor])) {
        cursor += 1;
      }
      return cursor;
    }
    if (character === '\r' || character === '\n') {
      throw new Error('Unterminated regular expression while scanning main.js');
    }
  }
  throw new Error('Unterminated regular expression while scanning main.js');
}

const regexPrefixKeywords = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function skipTemplate(source, start) {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === '`') {
      return cursor + 1;
    }
    if (character === '$' && source[cursor + 1] === '{') {
      cursor = findMatchingBrace(source, cursor + 1);
    }
  }
  throw new Error('Unterminated template literal while scanning main.js');
}

function findMatchingBrace(source, openingBraceIndex) {
  if (source[openingBraceIndex] !== '{') {
    throw new Error('Internal scanner error: opening brace was not found');
  }
  let depth = 1;
  let canStartRegex = true;
  for (
    let cursor = openingBraceIndex + 1;
    cursor < source.length;
    cursor += 1
  ) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(character)) {
      continue;
    }
    if (character === "'" || character === '"') {
      cursor = skipQuoted(source, cursor, character) - 1;
      canStartRegex = false;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplate(source, cursor) - 1;
      canStartRegex = false;
      continue;
    }
    if (character === '/' && next === '/') {
      cursor = skipLineComment(source, cursor) - 1;
      continue;
    }
    if (character === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor) - 1;
      continue;
    }
    if (character === '/' && canStartRegex) {
      cursor = skipRegex(source, cursor) - 1;
      canStartRegex = false;
      continue;
    }
    if (character === '{') {
      depth += 1;
      canStartRegex = true;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
      canStartRegex = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) {
        end += 1;
      }
      const token = source.slice(cursor, end);
      canStartRegex = regexPrefixKeywords.has(token);
      cursor = end - 1;
      continue;
    }
    if (/\d/.test(character)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) {
        end += 1;
      }
      canStartRegex = false;
      cursor = end - 1;
      continue;
    }
    if (character === ')' || character === ']') {
      canStartRegex = false;
      continue;
    }
    canStartRegex =
      character === '(' ||
      character === '[' ||
      character === ',' ||
      character === ';' ||
      character === ':' ||
      character === '?' ||
      '=!&|+-*%^~<>'.includes(character);
  }
  throw new Error('Unterminated module body while scanning main.js');
}

function findBodyOpeningBrace(source, start) {
  let parentheses = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(character)) {
      continue;
    }
    if (character === "'" || character === '"') {
      cursor = skipQuoted(source, cursor, character) - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplate(source, cursor) - 1;
      continue;
    }
    if (character === '/' && next === '/') {
      cursor = skipLineComment(source, cursor) - 1;
      continue;
    }
    if (character === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor) - 1;
      continue;
    }
    if (character === '(') {
      parentheses += 1;
      continue;
    }
    if (character === ')') {
      parentheses -= 1;
      if (parentheses < 0) {
        throw new Error('Invalid module parameter list while scanning main.js');
      }
      continue;
    }
    if (character === '{' && parentheses === 0) {
      return cursor;
    }
  }
  throw new Error('Module body opening brace was not found');
}

function findModuleRanges(source, moduleId) {
  const ranges = [];
  let cursor = 0;
  while (cursor < source.length) {
    const candidate = source.indexOf(moduleId, cursor);
    if (candidate < 0) {
      break;
    }
    const tokenEnd = candidate + moduleId.length;
    const previous = previousNonWhitespace(source, candidate);
    const nextIndex = nextNonWhitespaceIndex(source, tokenEnd);
    const hasStructuralPrefix = previous === '{' || previous === ',';
    const hasStructuralSuffix =
      source[nextIndex] === '(' ||
      (source[nextIndex] === ':' &&
        /^\s*:\s*function\b/.test(source.slice(tokenEnd, tokenEnd + 32)));
    if (hasStructuralPrefix && hasStructuralSuffix) {
      const openingBrace = findBodyOpeningBrace(source, nextIndex);
      const closingBrace = findMatchingBrace(source, openingBrace);
      ranges.push({
        start: candidate,
        end: closingBrace + 1,
        source: source.slice(candidate, closingBrace + 1),
      });
      cursor = closingBrace + 1;
      continue;
    }
    cursor = tokenEnd;
  }
  return ranges;
}

const options = parseArguments(process.argv.slice(2));
const moduleId = options.get('module-id');
const chunkId = options.get('chunk-id');
const baselineChunkHash = options.get('baseline-chunk-hash');
const currentChunkHash = options.get('current-chunk-hash');
assertIdentifier(moduleId, 'module-id');
assertIdentifier(chunkId, 'chunk-id');
assertChunkHash(baselineChunkHash, 'baseline-chunk-hash');
assertChunkHash(currentChunkHash, 'current-chunk-hash');
if (baselineChunkHash.toLowerCase() === currentChunkHash.toLowerCase()) {
  throw new Error('Baseline and current chunk hashes must differ');
}

const baselinePath = resolve(options.get('baseline'));
const currentPath = resolve(options.get('current'));
const outputPath = resolve(options.get('output'));
if (baselinePath === currentPath) {
  throw new Error('Baseline and current main.js paths must differ');
}
if (outputPath === currentPath) {
  throw new Error('Output must not overwrite the current main.js');
}

const baseline = readFileSync(baselinePath, 'utf8');
const current = readFileSync(currentPath, 'utf8');
const baselineRanges = findModuleRanges(baseline, moduleId);
const currentRanges = findModuleRanges(current, moduleId);
if (baselineRanges.length !== 1) {
  throw new Error(
    `Expected exactly one module ${moduleId} in baseline, got ${baselineRanges.length}`,
  );
}
if (currentRanges.length !== 1) {
  throw new Error(
    `Expected exactly one module ${moduleId} in current build, got ${currentRanges.length}`,
  );
}

const baselineModuleSha256 = sha256(baselineRanges[0].source);
const currentModuleSha256 = sha256(currentRanges[0].source);
assertExpectedHash(
  baselineModuleSha256,
  options.get('expected-baseline-module-sha256'),
  'Baseline module',
);
assertExpectedHash(
  currentModuleSha256,
  options.get('expected-current-module-sha256'),
  'Current module',
);

const oldMapping = `${chunkId}:"${baselineChunkHash}"`;
const newMapping = `${chunkId}:"${currentChunkHash}"`;
const baselineMappingCount = baseline.split(oldMapping).length - 1;
const currentMappingCount = current.split(newMapping).length - 1;
if (baselineMappingCount !== 1) {
  throw new Error(
    `Expected exactly one baseline chunk mapping ${oldMapping}, got ${baselineMappingCount}`,
  );
}
if (currentMappingCount !== 1) {
  throw new Error(
    `Expected exactly one current chunk mapping ${newMapping}, got ${currentMappingCount}`,
  );
}

let assembled =
  baseline.slice(0, baselineRanges[0].start) +
  currentRanges[0].source +
  baseline.slice(baselineRanges[0].end);
assembled = assembled.replace(oldMapping, newMapping);
if (
  assembled.split(newMapping).length - 1 !== 1 ||
  assembled.includes(oldMapping)
) {
  throw new Error('Assembled main.js chunk mapping verification failed');
}
new Script(assembled, { filename: outputPath });

mkdirSync(dirname(outputPath), { recursive: true });
const temporaryOutputPath = `${outputPath}.tmp-${process.pid}`;
try {
  writeFileSync(temporaryOutputPath, assembled, 'utf8');
  renameSync(temporaryOutputPath, outputPath);
} finally {
  rmSync(temporaryOutputPath, { force: true });
}

process.stdout.write(
  `${JSON.stringify({
    moduleId,
    chunkId,
    moduleReplacementCount: 1,
    mappingReplacementCount: 1,
    baselineModuleSha256,
    currentModuleSha256,
    outputSha256: sha256(assembled),
  })}\n`,
);
