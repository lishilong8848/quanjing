const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localMeetingPolicy } = require('../helpers/meeting-local-policy.cjs');
test('本地会话：拒绝外网/伪造Host/跨站写入/无会话，仅允许本机同源', () => {
  const policy = localMeetingPolicy(4204);
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:4200',
      origin: 'http://127.0.0.1:4200',
      'sec-fetch-site': 'same-origin',
    },
  };
  assert(policy.allowed(request));
  assert(!policy.authenticated(request));
  const authenticated = {
    ...request,
    headers: { ...request.headers, cookie: policy.cookie.split(';')[0] },
  };
  assert(policy.authenticated(authenticated));
  assert(
    !policy.allowed({ ...request, socket: { remoteAddress: '192.168.1.2' } }),
  );
  assert(
    !policy.allowed({
      ...request,
      headers: { ...request.headers, host: 'malicious.example:4200' },
    }),
  );
  assert(
    !policy.allowed({
      ...request,
      headers: { ...request.headers, origin: 'https://other.example' },
    }),
  );
  assert(
    !policy.allowed({
      ...request,
      headers: { ...request.headers, 'sec-fetch-site': 'cross-site' },
    }),
  );
  assert(
    !policy.authenticated({
      ...request,
      headers: { ...request.headers, cookie: 'nt_weekly_local_session=bad' },
    }),
  );
  assert(
    !policy.authenticated({
      ...request,
      headers: {
        ...request.headers,
        cookie: 'nt_weekly_local_session=' + '马'.repeat(64),
      },
    }),
  );
});
