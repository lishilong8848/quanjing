import type { RequestHandler } from 'express';
import type { HotfixActivation } from './hotfix-activation';

export function createHotfixActivationMiddleware(
  gate: Pick<HotfixActivation, 'status' | 'isAcceptingNewWork'>,
  apiMountPath: string,
): RequestHandler {
  const healthPaths = new Set([`${apiMountPath}/access/session`, `${apiMountPath}/feishu-card-callback/health`]);
  return (request, response, next) => {
    const accepting = gate.isAcceptingNewWork(), state = gate.status();
    const health = request.method === 'GET' && healthPaths.has(request.path);
    if (health) {
      response.setHeader('X-Nantong-Hotfix-Activation', state.phase);
      response.setHeader('X-Nantong-Hotfix-Deployment', state.deploymentId ?? 'unmanaged');
      response.setHeader('X-Nantong-Hotfix-Accepting', String(accepting && state.phase === 'active'));
      response.setHeader('Cache-Control', 'no-store');
    }
    if (state.phase !== 'failed' && state.phase !== 'closed' && (health || accepting && state.phase === 'active')) {
      next(); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', '5');
    response.status(503).json({ status: 'maintenance', message: '系统更新中，请稍后重试' });
  };
}
