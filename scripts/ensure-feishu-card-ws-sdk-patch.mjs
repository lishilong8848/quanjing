import { resolve } from 'node:path';
import { patchFeishuCardCallbackFrames } from './postinstall.mjs';

const rootDir = resolve(process.argv[2] || process.cwd());

try {
  const result = patchFeishuCardCallbackFrames({
    rootDir,
    logger: { log: () => undefined },
  });
  if (result.status === 'not-installed') {
    throw new Error('@larksuiteoapi/node-sdk is not installed');
  }
  console.log('[startup] Feishu card callback WebSocket compatibility: READY');
} catch (error) {
  const message =
    error instanceof Error && error.message
      ? error.message.replace(/[\r\n\t]/gu, ' ').slice(0, 300)
      : 'unknown error';
  console.error(
    `[startup] Feishu card callback WebSocket compatibility: FAILED (${message})`,
  );
  process.exitCode = 1;
}
