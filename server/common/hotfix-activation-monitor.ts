import type { HotfixActivation } from './hotfix-activation';

export async function startHotfixActivationMonitor(
  gate: HotfixActivation,
  reportError: (reason: string) => void,
): Promise<{ stop(): Promise<void> }> {
  gate.completeBootstrap();
  await gate.refresh();
  if (gate.status().phase === 'closed') throw new Error('HOTFIX_ACTIVATION_CLOSED');
  let pending: Promise<void> | undefined, closing: Promise<void> | undefined, stopping = false;
  const timer = setInterval(() => {
    if (stopping || pending || gate.isAcceptingNewWork()) return;
    pending = gate.refresh().catch(error => {
      clearInterval(timer);
      reportError(error instanceof Error && /^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : 'HOTFIX_ACTIVATION_FAILED');
    }).finally(() => { pending = undefined; });
  }, 100);
  timer.unref();
  return { stop: () => {
    stopping = true; clearInterval(timer);
    closing ??= (async () => { await gate.close(); await pending; })();
    return closing;
  } };
}
