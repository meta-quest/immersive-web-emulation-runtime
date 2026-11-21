/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic ECDSA (RFC 6979) so EC-signed APKs are byte-identical across
 * packs (PKG-9). node:crypto's ECDSA uses random nonces; the nonce here comes
 * from the RFC 6979 section 3.2 HMAC-DRBG over the private key and the
 * message hash. The point multiplication k*G is done by node:crypto's ECDH
 * (the public key of private scalar k), so no curve arithmetic is
 * reimplemented; only the scalar arithmetic mod n is done with BigInt.
 *
 * Signatures are standard ECDSA: any verifier accepts them. The caller still
 * verifies every signature with node:crypto.
 */

import {
  createECDH,
  createHmac,
  createHash,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { int, seq } from './der.ts';

/** Group orders (`openssl ecparam -param_enc explicit -text`). */
const CURVE_ORDER: Record<string, bigint> = {
  prime256v1: BigInt(
    '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
  ),
  secp384r1: BigInt(
    '0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973',
  ),
  secp521r1: BigInt(
    '0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409',
  ),
};
const ALIASES: Record<string, string> = {
  'P-256': 'prime256v1',
  'P-384': 'secp384r1',
  'P-521': 'secp521r1',
};

const bitLength = (n: bigint) => n.toString(2).length;

function toBig(b: Buffer): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${b.toString('hex')}`);
}

function toBytes(x: bigint, length: number): Buffer {
  const hex = x.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex.slice(hex.length - length * 2), 'hex');
}

function mod(a: bigint, n: bigint): bigint {
  const r = a % n;
  return r < 0n ? r + n : r;
}

function modInverse(a: bigint, n: bigint): bigint {
  let [oldR, r] = [mod(a, n), n];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, n);
}

/** Whether this key can be signed deterministically. */
export function supportsDeterministicEcdsa(key: KeyObject): boolean {
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return (
    key.type === 'private' &&
    key.asymmetricKeyType === 'ec' &&
    !!curve &&
    !!CURVE_ORDER[ALIASES[curve] ?? curve]
  );
}

/**
 * RFC 6979 ECDSA signature (DER `Ecdsa-Sig-Value`) of `data` hashed with
 * `hash`. Returns null if the key is not a supported EC key; throws if the
 * result does not verify (it then must not be used).
 */
export function signEcdsaDeterministic(
  hash: 'sha256' | 'sha384' | 'sha512',
  data: Buffer,
  key: KeyObject,
): Buffer | null {
  if (!supportsDeterministicEcdsa(key)) return null;
  const rawCurve = key.asymmetricKeyDetails!.namedCurve!;
  const curve = ALIASES[rawCurve] ?? rawCurve;
  const n = CURVE_ORDER[curve];
  const qlen = bitLength(n);
  const rlen = Math.ceil(qlen / 8);
  const jwk = key.export({ format: 'jwk' }) as { d?: string };
  if (!jwk.d) return null;
  const x = toBig(Buffer.from(jwk.d, 'base64url'));

  const bits2int = (b: Buffer): bigint => {
    const v = toBig(b);
    const blen = b.length * 8;
    return blen > qlen ? v >> BigInt(blen - qlen) : v;
  };
  const h1 = createHash(hash).update(data).digest();
  const e = bits2int(h1);
  const xOctets = toBytes(x, rlen);
  const hOctets = toBytes(mod(e, n), rlen);

  const hmac = (k: Buffer, ...parts: Buffer[]) => {
    const h = createHmac(hash, k);
    for (const p of parts) h.update(p);
    return h.digest();
  };
  const hlen = h1.length;
  let V = Buffer.alloc(hlen, 0x01);
  let K = Buffer.alloc(hlen, 0x00);
  K = hmac(K, V, Buffer.from([0x00]), xOctets, hOctets);
  V = hmac(K, V);
  K = hmac(K, V, Buffer.from([0x01]), xOctets, hOctets);
  V = hmac(K, V);

  const ecdh = createECDH(curve);
  for (let attempt = 0; attempt < 64; attempt++) {
    let T = Buffer.alloc(0);
    while (T.length * 8 < qlen) {
      V = hmac(K, V);
      T = Buffer.concat([T, V]);
    }
    const k = bits2int(T);
    if (k >= 1n && k < n) {
      ecdh.setPrivateKey(toBytes(k, rlen));
      const point = ecdh.getPublicKey(null, 'uncompressed');
      const fieldLen = (point.length - 1) / 2;
      const r = mod(toBig(point.subarray(1, 1 + fieldLen)), n);
      if (r !== 0n) {
        const s = mod(modInverse(k, n) * (e + r * x), n);
        if (s !== 0n) {
          const sig = seq(int(r), int(s));
          if (!cryptoVerify(hash, data, key, sig))
            throw new Error('deterministic ECDSA signature does not verify');
          return sig;
        }
      }
    }
    K = hmac(K, V, Buffer.from([0x00]));
    V = hmac(K, V);
  }
  throw new Error('deterministic ECDSA: no valid nonce');
}
