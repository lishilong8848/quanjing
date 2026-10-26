import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyFeishuAccessStartupAtRoot(root, options = {}) {
  root = resolve(root);
  const scriptRoot = options.scriptRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const runtime = scriptRoot.endsWith('release-root')
    ? join(dirname(scriptRoot), 'dist/server/common/access/feishu-access.service.js')
    : join(root, 'dist/server/common/access/feishu-access.service.js');
  if (!existsSync(runtime)) {
    if (scriptRoot.endsWith('release-root')) throw new Error('FEISHU_ACCESS_CANDIDATE_RUNTIME_MISSING');
    return { status: 'runtime-unavailable-config-only', readonly: true, writes: 0, networkCalls: 0 };
  }
  const previous = process.env;
  try {
    process.env = { ...(options.environment ?? previous), NODE_PATH: [options.dependencyRoot ?? join(root, 'node_modules'), previous.NODE_PATH].filter(Boolean).join(delimiter) };
    Module._initPaths();
    const require = createRequire(join(root, 'package.json'));
    const { parse } = require('dotenv');
    const environment = { ...process.env };
    for (const file of [join(root, '.env'), join(root, '.env.local')]) {
      if (existsSync(file)) Object.assign(environment, parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    }
    require('reflect-metadata');
    const { FeishuAccessService } = require(runtime);
    const noNetwork = new Proxy({}, { get() { throw new Error('FEISHU_ACCESS_PREFLIGHT_NETWORK_FORBIDDEN'); } });
    // Constructor uses the same role/configuration validation as Nest, without OAuth or lifecycle calls.
    new FeishuAccessService({ get: name => environment[name] }, noNetwork);
    return { status: 'verified-readonly', readonly: true, writes: 0, networkCalls: 0 };
  } catch {
    throw new Error('FEISHU_ACCESS_CONFIGURATION_INVALID');
  } finally {
    process.env = previous;
    Module._initPaths();
  }
}
