// Test helpers (not a test file). Local HTTP servers, a tar writer, and a tiny OpenPGP signer.
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

export async function startServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Serve `body` with Range / If-Range support. opts.etag, opts.dropAt (bytes) for the first `dropTimes` requests. */
export function rangeHandler(getState) {
  return (req, res, n) => {
    const st = getState(n, req);
    const { body, etag } = st;
    const headers = { 'accept-ranges': 'bytes' };
    if (etag) headers.etag = etag;
    let start = 0;
    let status = 200;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (range && !st.ignoreRange) {
      const ifRange = req.headers['if-range'];
      if (!ifRange || ifRange === etag) {
        start = Number(range[1]);
        status = 206;
        headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
      }
    }
    const slice = body.subarray(start);
    headers['content-length'] = slice.length;
    res.writeHead(status, headers);
    if (st.dropAt != null) {
      res.write(slice.subarray(0, st.dropAt));
      setTimeout(() => res.socket.destroy(), 20);
    } else if (st.slow) {
      let i = 0;
      const t = setInterval(() => {
        if (i >= slice.length || res.destroyed) {
          clearInterval(t);
          res.end();
          return;
        }
        res.write(slice.subarray(i, i + st.slow));
        i += st.slow;
      }, 15);
      res.on('close', () => clearInterval(t));
    } else res.end(slice);
  };
}

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- tar
function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header({ name, size = 0, type = '0', mode = 0o644, linkname = '' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxRecords(obj) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    const body = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(body) + 1;
    while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
    out += `${len}${body}`;
  }
  return Buffer.from(out);
}

/** entries: [{ name, data?, type?, mode?, linkname?, pax? }] */
export function buildTar(entries, { gzip = false } = {}) {
  const parts = [];
  for (const e of entries) {
    const data = e.data == null ? Buffer.alloc(0) : Buffer.from(e.data);
    if (e.pax) {
      const p = paxRecords(e.pax);
      parts.push(header({ name: 'PaxHeader/x', size: p.length, type: 'x' }), pad(p));
    }
    parts.push(header({ ...e, size: e.type === '5' ? 0 : data.length }), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gzip ? zlib.gzipSync(tar) : tar;
}

// ---------------------------------------------------------------- OpenPGP signer (RSA, v4)
function crc24(buf) {
  let c = 0xb704ce;
  for (const byte of buf) {
    c ^= byte << 16;
    for (let k = 0; k < 8; k++) {
      c <<= 1;
      if (c & 0x1000000) c ^= 0x1864cfb;
    }
  }
  return Buffer.from([(c >> 16) & 255, (c >> 8) & 255, c & 255]);
}

function armor(kind, bin) {
  const b64 = bin.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PGP ${kind}-----\n\n${b64}\n=${crc24(bin).toString('base64')}\n-----END PGP ${kind}-----\n`;
}

const mpi = (buf) => {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  const b = buf.subarray(i);
  const bits = (b.length - 1) * 8 + (32 - Math.clz32(b[0]));
  return Buffer.concat([Buffer.from([bits >> 8, bits & 255]), b]);
};

const packet = (tag, body) => {
  const h = Buffer.alloc(6);
  h[0] = 0xc0 | tag;
  h[1] = 255;
  h.writeUInt32BE(body.length, 2);
  return Buffer.concat([h, body]);
};

export function makePgpKey(name = 'Test Signing <test@example.invalid>') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const body = Buffer.concat([
    Buffer.from([4, 0, 0, 0, 1, 1]),
    mpi(Buffer.from(jwk.n, 'base64url')),
    mpi(Buffer.from(jwk.e, 'base64url')),
  ]);
  body.writeUInt32BE(1700000000, 1);
  const fingerprint = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from([0x99, body.length >> 8, body.length & 255]), body]))
    .digest('hex')
    .toUpperCase();
  const armoredPublic = armor('PUBLIC KEY BLOCK', Buffer.concat([packet(6, body), packet(13, Buffer.from(name))]));
  return {
    fingerprint,
    armoredPublic,
    sign(data) {
      const hashed = Buffer.concat([
        Buffer.from([5, 2, 0x65, 0x00, 0x00, 0x00]),
        Buffer.from([22, 33, 4]),
        Buffer.from(fingerprint, 'hex'),
      ]);
      const hdr = Buffer.concat([Buffer.from([4, 0, 1, 8, hashed.length >> 8, hashed.length & 255]), hashed]);
      const trailer = Buffer.alloc(6);
      trailer[0] = 4;
      trailer[1] = 0xff;
      trailer.writeUInt32BE(hdr.length, 2);
      const digest = crypto.createHash('sha256').update(Buffer.concat([data, hdr, trailer])).digest();
      const sig = crypto.sign('sha256', Buffer.concat([data, hdr, trailer]), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
      const bin = packet(2, Buffer.concat([hdr, Buffer.from([0, 0]), digest.subarray(0, 2), mpi(sig)]));
      return armor('SIGNATURE', bin);
    },
  };
}
