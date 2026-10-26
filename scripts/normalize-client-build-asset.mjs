import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--asset' || !args[1]) {
  throw new Error('Usage: node normalize-client-build-asset.mjs --asset <path>');
}

const assetPath = resolve(args[1]);
const bytes = readFileSync(assetPath);
const source = bytes.toString('utf8');
const buildTimePattern =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const buildTimes = source.match(buildTimePattern) ?? [];
const normalizedSource = source.replace(buildTimePattern, '<BUILD_TIME>');
const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex').toUpperCase();

process.stdout.write(
  `${JSON.stringify({
    fullSha256: sha256(bytes),
    normalizedSha256: sha256(Buffer.from(normalizedSource, 'utf8')),
    buildTimeCount: buildTimes.length,
  })}\n`,
);
