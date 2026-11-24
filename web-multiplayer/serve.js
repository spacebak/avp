'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const build = path.resolve(__dirname, '../build-web');
const address = process.argv[2] || '127.0.0.1';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/assets.js', ['assets.js', 'application/javascript']],
  ['/avp.js', ['avp.js', 'application/javascript']],
  ['/avp.wasm', ['avp.wasm', 'application/wasm']],
  ['/avp.data', ['avp.data', 'application/octet-stream']]
]);
for (const [file] of files.values()) fs.accessSync(path.join(build, file), fs.constants.R_OK);

http.createServer((req, res) => {
  const resource = files.get(req.url.split('?')[0]);
  if (!resource || !['HEAD', 'GET'].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  const [file, type] = resource;
  const filename = path.join(build, file);
  fs.stat(filename, (err, stat) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') res.end();
    else {
      const stream = fs.createReadStream(filename);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  });
}).listen(8788, address, () => console.log(`AvP is ready at http://${address}:8788/`));
