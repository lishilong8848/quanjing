const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.TEMP, 'nt-threshold-client-hvac-static');
if (!fs.existsSync(path.join(root, 'index.html')))
  throw new Error('隔离产物不存在');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/__innerapi__/')
  ) {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: 4191,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: '127.0.0.1:4191' },
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.writeHead(502);
      response.end('验收服务连接失败');
    });
    request.pipe(upstream);
    return;
  }
  let name;
  try {
    name = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const assetRoot = name.startsWith('/assets/')
    ? path.resolve(__dirname, '../../client/public')
    : root;
  const file = path.resolve(
    assetRoot,
    '.' + (path.extname(name) ? name : '/index.html'),
  );
  const relative = path.relative(assetRoot, file);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !fs.existsSync(file)
  ) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader(
    'Content-Type',
    {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.woff2': 'font/woff2',
    }[path.extname(file)] || 'application/octet-stream',
  );
  fs.createReadStream(file).pipe(response);
});
server.listen(4190, '127.0.0.1', () =>
  console.log('threshold static fixture ready: http://127.0.0.1:4190'),
);
process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
