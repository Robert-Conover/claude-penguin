// Minimal OpenPGP detached-signature verifier built on node:crypto.
// Scope: v4 RSA public keys, v4 binary-document signatures (type 0x00) with
// SHA-256/384/512 hashes. That is what Anthropic's release key uses. Anything
// else is rejected rather than guessed at. No web of trust, expiry or
// revocation handling: trust comes from pinning the primary-key fingerprint.
import crypto from 'node:crypto';

export class OpenPgpError extends Error {
  constructor(message, code = 'OPENPGP') {
    super(message);
    this.name = 'OpenPgpError';
    this.code = code;
  }
}

export function dearmor(input) {
  if (Buffer.isBuffer(input)) {
    if (input[0] !== 0x2d) return input; // already binary
    input = input.toString('utf8');
  }
  const lines = String(input).replace(/\r/g, '').split('\n');
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP'));
  const end = lines.findIndex((l, i) => i > begin && l.startsWith('-----END PGP'));
  if (begin < 0 || end < 0) throw new OpenPgpError('not an ASCII-armored PGP block');
  let i = begin + 1;
  while (i < end && lines[i].trim() !== '') i++; // skip armor headers
  const body = [];
  let crc = null;
  for (i++; i < end; i++) {
    const l = lines[i].trim();
    if (l.startsWith('=')) crc = l.slice(1);
    else body.push(l);
  }
  const data = Buffer.from(body.join(''), 'base64');
  if (crc) {
    const want = Buffer.from(crc, 'base64');
    let c = 0xb704ce;
    for (const byte of data) {
      c ^= byte << 16;
      for (let k = 0; k < 8; k++) {
        c <<= 1;
        if (c & 0x1000000) c ^= 0x1864cfb;
      }
    }
    c &= 0xffffff;
    if (want.length !== 3 || want.readUIntBE(0, 3) !== c) throw new OpenPgpError('armor CRC24 mismatch');
  }
  return data;
}

export function parsePackets(buf) {
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    const h = buf[i++];
    if (!(h & 0x80)) throw new OpenPgpError('bad packet header');
    let tag;
    let len;
    if (h & 0x40) {
      tag = h & 0x3f;
      const l = buf[i++];
      if (l < 192) len = l;
      else if (l < 224) len = ((l - 192) << 8) + buf[i++] + 192;
      else if (l === 255) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else throw new OpenPgpError('partial-length packets are not supported');
    } else {
      tag = (h >> 2) & 15;
      const t = h & 3;
      if (t === 0) len = buf[i++];
      else if (t === 1) {
        len = buf.readUInt16BE(i);
        i += 2;
      } else if (t === 2) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else throw new OpenPgpError('indeterminate-length packets are not supported');
    }
    if (i + len > buf.length) throw new OpenPgpError('truncated packet');
    packets.push({ tag, body: buf.subarray(i, i + len) });
    i += len;
  }
  return packets;
}

function readMpi(buf, off) {
  const bits = buf.readUInt16BE(off);
  const bytes = (bits + 7) >> 3;
  return { value: buf.subarray(off + 2, off + 2 + bytes), next: off + 2 + bytes };
}

function parsePublicKeyPacket(body) {
  if (body[0] !== 4) throw new OpenPgpError(`unsupported public key version ${body[0]}`);
  const algo = body[5];
  if (algo !== 1 && algo !== 3) throw new OpenPgpError(`unsupported public key algorithm ${algo} (RSA only)`);
  const n = readMpi(body, 6);
  const e = readMpi(body, n.next);
  const fingerprint = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from([0x99, body.length >> 8, body.length & 255]), body]))
    .digest('hex')
    .toUpperCase();
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: n.value.toString('base64url'), e: e.value.toString('base64url') },
    format: 'jwk',
  });
  return { fingerprint, keyId: fingerprint.slice(-16), created: body.readUInt32BE(1), key, bits: n.value.length * 8 };
}

/** Parse an armored or binary key. Returns { primary, subkeys, userIds }. */
export function parsePublicKey(input) {
  const packets = parsePackets(dearmor(input));
  const keys = [];
  const userIds = [];
  for (const p of packets) {
    if (p.tag === 6 || p.tag === 14) keys.push({ ...parsePublicKeyPacket(p.body), subkey: p.tag === 14 });
    else if (p.tag === 13) userIds.push(p.body.toString('utf8'));
  }
  if (!keys.length || keys[0].subkey) throw new OpenPgpError('no primary public key found');
  return { primary: keys[0], subkeys: keys.slice(1), userIds };
}

const HASHES = { 8: 'sha256', 9: 'sha384', 10: 'sha512' };

function parseSubpackets(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let l = buf[i++];
    if (l >= 192 && l < 255) l = ((l - 192) << 8) + buf[i++] + 192;
    else if (l === 255) {
      l = buf.readUInt32BE(i);
      i += 4;
    }
    out.push({ type: buf[i] & 0x7f, data: buf.subarray(i + 1, i + l) });
    i += l;
  }
  return out;
}

export function parseSignature(input) {
  const packets = parsePackets(dearmor(input));
  const p = packets.find((x) => x.tag === 2);
  if (!p) throw new OpenPgpError('no signature packet');
  const b = p.body;
  if (b[0] !== 4) throw new OpenPgpError(`unsupported signature version ${b[0]}`);
  const type = b[1];
  const pubAlgo = b[2];
  const hashAlgo = b[3];
  const hashedLen = b.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  const hashed = b.subarray(6, hashedEnd);
  const unhashedLen = b.readUInt16BE(hashedEnd);
  const unhashed = b.subarray(hashedEnd + 2, hashedEnd + 2 + unhashedLen);
  const rest = hashedEnd + 2 + unhashedLen;
  const sig = readMpi(b, rest + 2).value;
  const subs = [...parseSubpackets(hashed), ...parseSubpackets(unhashed)];
  const issuerFp = subs.find((s) => s.type === 33 && s.data[0] === 4);
  const issuerId = subs.find((s) => s.type === 16);
  return {
    type,
    pubAlgo,
    hashAlgo,
    header: b.subarray(0, hashedEnd),
    hashLen: HASHES[hashAlgo],
    signature: sig,
    issuerFingerprint: issuerFp ? issuerFp.data.subarray(1).toString('hex').toUpperCase() : null,
    issuerKeyId: issuerId ? issuerId.data.toString('hex').toUpperCase() : null,
  };
}

/**
 * Verify a detached binary signature over `data` (Buffer).
 * `expectedFingerprint` pins the PRIMARY key; the supplied key file must match it
 * before any signature is considered. Returns { fingerprint, keyId, userIds } or throws.
 */
export function verifyDetached({ data, signature, publicKey, expectedFingerprint }) {
  if (!expectedFingerprint) throw new OpenPgpError('expectedFingerprint is required', 'NO_PIN');
  const pin = expectedFingerprint.replace(/\s+/g, '').toUpperCase();
  const key = parsePublicKey(publicKey);
  if (key.primary.fingerprint !== pin) {
    throw new OpenPgpError(
      `public key fingerprint ${key.primary.fingerprint} does not match pinned ${pin}`,
      'FINGERPRINT_MISMATCH',
    );
  }
  const sig = parseSignature(signature);
  if (sig.type !== 0x00) throw new OpenPgpError(`unsupported signature type ${sig.type}`);
  if (sig.pubAlgo !== 1 && sig.pubAlgo !== 3) throw new OpenPgpError('unsupported signature algorithm');
  if (!sig.hashLen) throw new OpenPgpError(`unsupported hash algorithm ${sig.hashAlgo}`);
  const candidates = [key.primary, ...key.subkeys];
  let signer = null;
  if (sig.issuerFingerprint) signer = candidates.find((k) => k.fingerprint === sig.issuerFingerprint);
  else if (sig.issuerKeyId) signer = candidates.find((k) => k.keyId === sig.issuerKeyId);
  if (!signer) throw new OpenPgpError('signature was not issued by the pinned key', 'WRONG_SIGNER');
  const trailer = Buffer.alloc(6);
  trailer[0] = 4;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(sig.header.length, 2);
  const ok = crypto.verify(
    sig.hashLen,
    Buffer.concat([data, sig.header, trailer]),
    { key: signer.key, padding: crypto.constants.RSA_PKCS1_PADDING },
    sig.signature.length < signer.bits / 8
      ? Buffer.concat([Buffer.alloc(signer.bits / 8 - sig.signature.length), sig.signature])
      : sig.signature,
  );
  if (!ok) throw new OpenPgpError('BAD signature', 'BAD_SIGNATURE');
  return { fingerprint: key.primary.fingerprint, signerKeyId: signer.keyId, userIds: key.userIds };
}
