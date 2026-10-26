const { randomBytes, timingSafeEqual } = require('node:crypto');
function localMeetingPolicy(port, frontendPort = 4200) {
  const token = randomBytes(32).toString('hex');
  const cookieName = 'nt_weekly_local_session';
  const hosts = new Set([`127.0.0.1:${port}`, `127.0.0.1:${frontendPort}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return {
    allowed(request) {
      return (
        ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(
          request.socket.remoteAddress,
        ) &&
        hosts.has(request.headers.host) &&
        (!request.headers.origin || origins.has(request.headers.origin)) &&
        !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])
      );
    },
    authenticated(request) {
      const candidate =
        (request.headers.cookie || '')
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(cookieName + '='))
          ?.slice(cookieName.length + 1) || '';
      const candidateBytes = Buffer.from(candidate);
      const tokenBytes = Buffer.from(token);
      return (
        candidateBytes.length === tokenBytes.length &&
        timingSafeEqual(candidateBytes, tokenBytes)
      );
    },
    cookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
  };
}
module.exports = { localMeetingPolicy };
