// HTTPS fronts so dist/index.js can run against devstack, whose gateway and MinIO speak http.
// :8443 forwards to the gateway on :8082. :9443 forwards to MinIO on :9000 with the Host header
// unchanged, because a presigned URL's SigV4 signature covers the Host it was signed for.
// Usage: node scripts/devstack-tls-proxy.mjs <cert.pem> <key.pem>
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [certPath, keyPath] = process.argv.slice(2);
if (!certPath || !keyPath) {
  console.error("usage: node scripts/devstack-tls-proxy.mjs <cert.pem> <key.pem>");
  process.exit(2);
}
const tls = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };

function front(listen, port, keepHost) {
  https
    .createServer(tls, (req, res) => {
      const headers = keepHost ? req.headers : { ...req.headers, host: `localhost:${port}` };
      const up = http.request({ host: "localhost", port, path: req.url, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      req.pipe(up);
    })
    .listen(listen, () => console.log(`https://localhost:${listen} -> http://localhost:${port}`));
}

front(8443, 8082, false);
front(9443, 9000, true);
