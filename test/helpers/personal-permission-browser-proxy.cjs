const http = require('node:http');
const server = http.createServer((request, response) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: 43224, path: request.url, method: request.method, headers: request.headers }, result => {
    response.writeHead(result.statusCode, result.headers); result.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(503); response.end('synthetic fixture unavailable'); });
  request.pipe(upstream);
});
server.listen(43223, '127.0.0.1', () => console.log('personal permission API proxy ready 43223; no compilation'));
const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
