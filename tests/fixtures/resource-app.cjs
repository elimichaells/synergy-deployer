// Explicitly deployed acceptance fixture; importing this file does not start a server.
if (require.main === module) {
  const http = require('node:http');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: true, fixture: 'manager-resource-acceptance' }));
  });
  server.listen(Number(process.env.PORT || 33123), '127.0.0.1');
  process.on('SIGTERM', () => server.close());
}
