import { inspect } from 'node:util';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';
const middleware = new AccessLoginRedactionMiddleware();
const secret = 'synthetic private description';
const routes = [
  { route: 'personal/permission-requests', body: { clientMutationId: 'synthetic', permissions: [{ kind: 'page', path: '/' }], reason: secret }, field: 'reason' },
  { route: 'personal/permission-requests/update', body: { clientMutationId: 'synthetic', requestId: 'test', expectedRequestVersion: 1, reason: secret }, field: 'reason' },
  { route: 'configuration/permission-requests', body: { clientMutationId: 'synthetic', requestId: 'test', expectedRequestVersion: 1, decision: 'reject', comment: secret }, field: 'comment' },
  { route: 'personal/archive-corrections', body: { clientMutationId: 'synthetic', fields: ['phone'], description: secret }, field: 'description' },
  { route: 'configuration/archive-corrections', body: { clientMutationId: 'synthetic', requestId: 'test', expectedRequestVersion: 1, decision: 'resolve', comment: secret }, field: 'comment' },
];
function redact(route: string, input: unknown) {
  const request = { originalUrl: `/platform/api/access/${route}/?probe=1`, body: input };
  const next = jest.fn(); middleware.use(request as never, {} as never, next);
  expect(next).toHaveBeenCalledTimes(1); return request.body as Record<string, unknown>;
}
describe('personal workflow request tracing', () => {
  it.each(routes)('keeps $route usable by validation but private in normal trace', ({ route, body, field }) => {
    const result = redact(route, body);
    expect(result[field]).toBe(secret); expect(Object.getOwnPropertyNames(result).sort()).toEqual(Object.keys(body).sort());
    expect(JSON.stringify(result)).not.toContain(secret); expect(inspect(result)).not.toContain(secret);
    expect(result.clientMutationId).toBe('synthetic'); expect(result.invalidFields).toBeUndefined();
  });
  it.each(routes)('does not drop unknown fields silently for $route', ({ route, body }) => {
    const result = redact(route, { ...body, extraPrivateData: secret });
    expect(result.invalidFields).toBe(true); expect(inspect(result)).not.toContain(secret);
  });
  it.each([null, ['private'], 'private'])('rejects malformed workflow bodies without retaining contents', value => {
    expect(redact('personal/archive-corrections', value)).toEqual({ invalidFields: true });
  });
  it('preserves account mutations and private password on a trailing slash', () => {
    const result = redact('configuration/accounts', { name: 'synthetic', password: secret, enabled: true, clientMutationId: 'synthetic' });
    expect(result.name).toBe('synthetic'); expect(result.enabled).toBe(true); expect(result.password).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(['personal/password/change', 'personal/password/reset', 'configuration/accounts', 'login'])('does not expose malformed credential arrays on %s', route => {
    const result = redact(route, [{ password: secret, newPassword: secret, identityNumber: secret }]);
    expect(result.invalidFields).toBe(true); expect(inspect(result)).not.toContain(secret);
  });
});
