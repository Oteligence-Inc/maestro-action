// HTTPS fronts so dist/index.js can run against devstack, whose gateway and MinIO speak http.
// :8443 forwards to the gateway on :8082. :9443 forwards to MinIO on :9000 with the Host header
// unchanged, because a presigned URL's SigV4 signature covers the Host it was signed for.
// TLS_PROXY_GATEWAY=host:port retargets :8443 (a private-cloud VM's http address), and
// TLS_PROXY_S3=none leaves :9443 out when presigned URLs already point at https storage.
// Both listen on 127.0.0.1 (TLS_PROXY_BIND overrides): a front reachable from the network would relay any peer to
// the gateway behind it, past whatever limits who reaches that gateway directly.
// TLS_PROXY_TAMPER=<text>, for tests only, flips the last byte of every successful :9443 response whose path holds
// the text, so a run can show the action refusing a download that does not match its build's record.
// Usage: node scripts/devstack-tls-proxy.mjs <cert.pem> <key.pem>
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [certPath, keyPath] = process.argv.slice(2);
if (!certPath || !keyPath) {
  console.error("usage: node scripts/devstack-tls-proxy.mjs <cert.pem> <key.pem>");
  process.exit(2);
}
const BIND = process.env.TLS_PROXY_BIND || "127.0.0.1";
const tls = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };

function upstream(value, fallback) {
  const [host, port] = (value || fallback).split(":");
  return { host, port: Number(port) };
}

function front(listen, { host, port }, keepHost, tamper) {
  https
    .createServer(tls, (req, res) => {
      const headers = keepHost ? req.headers : { ...req.headers, host: `${host}:${port}` };
      const up = http.request({ host, port, path: req.url, method: req.method, headers }, (r) => {
        const pathOnly = req.url.split("?")[0];
        if (tamper && r.statusCode === 200 && pathOnly.includes(tamper)) {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks);
            if (body.length > 0) body[body.length - 1] ^= 0x01;
            // The path only: the query is the presigned URL's signature.
            console.log(`tampered ${pathOnly}`);
            res.writeHead(r.statusCode, r.headers);
            res.end(body);
          });
          return;
        }
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      req.pipe(up);
    })
    .listen(listen, BIND, () => console.log(`https://localhost:${listen} (${BIND}) -> http://${host}:${port}`));
}

front(8443, upstream(process.env.TLS_PROXY_GATEWAY, "localhost:8082"), false);
if (process.env.TLS_PROXY_S3 !== "none") {
  front(9443, upstream(process.env.TLS_PROXY_S3, "localhost:9000"), true, process.env.TLS_PROXY_TAMPER || "");
}
