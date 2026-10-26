import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HotfixActivation } from './hotfix-activation';
import { inspectHotfixReleaseProof } from './hotfix-release-proof';

const roots = new Map<string, HotfixActivation>();
const owners = new WeakMap<object, HotfixActivation>();
const rootKey = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;

export function currentHotfixActivation(): HotfixActivation {
  const root = resolve(process.cwd());
  const key = rootKey(root), existing = roots.get(key);
  if (existing) return existing;
  const gate = new HotfixActivation({ inspect: () => inspectHotfixReleaseProof(root), hasMaintenance: () => {
    try { lstatSync(join(root, '.maintenance.lock')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  } });
  roots.set(key, gate);
  return gate;
}
export function runHotfixInitialization(owner: object, initialize: () => void | Promise<void>): Promise<void> {
  const gate = owners.get(owner) ?? currentHotfixActivation();
  owners.set(owner, gate);
  return gate.run(owner, initialize);
}
export async function cancelHotfixInitialization(owner: object): Promise<void> {
  const gate = owners.get(owner) ?? currentHotfixActivation();
  owners.set(owner, gate);
  await gate.cancel(owner);
}
export async function closeHotfixActivation(): Promise<void> {
  const gate = roots.get(rootKey(resolve(process.cwd())));
  if (gate) await gate.close();
}
