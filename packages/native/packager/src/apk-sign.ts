/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * APK Signature Scheme v2 and v3 (PKG-7), signer and verifier, in Node.
 *
 * Written from the public Android documentation ("APK Signature Scheme v2",
 * "APK Signature Scheme v3" on source.android.com): the APK Signing Block
 * sits between the ZIP entries and the central directory; the signed digest
 * covers the entries, the central directory and the end-of-central-directory
 * record (with its central-directory offset pointing at the signing block),
 * split into 1 MiB chunks; all integers are little-endian and every
 * variable-size field is uint32-length-prefixed.
 */

import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { signEcdsaDeterministic } from './ecdsa.ts';
import { readZip, type WrittenZip } from './zip.ts';
import type { SigningIdentity } from './signing-key.ts';

export const BLOCK_ID = {
  v2: 0x7109871a,
  v3: 0xf05368c0,
  /** Padding pair Android's tools add so the block is a multiple of 4096 bytes. */
  verityPadding: 0x42726577,
} as const;

/** v2 signed-data attribute: "this APK also has a v3 signature" (stripping protection). */
const STRIPPING_PROTECTION_ATTR = 0xbeeff00d;
const MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const CHUNK = 1024 * 1024;

export const SIG_ALG = {
  RSA_PKCS1_SHA256: 0x0103,
  RSA_PKCS1_SHA512: 0x0104,
  ECDSA_SHA256: 0x0201,
  ECDSA_SHA512: 0x0202,
} as const;

interface AlgorithmInfo {
  id: number;
  /** Content digest (chunked) hash. */
  digest: 'sha256' | 'sha512';
  /** node:crypto sign() hash. */
  hash: 'sha256' | 'sha512';
}

const ALGORITHMS: Record<number, AlgorithmInfo> = {
  [SIG_ALG.RSA_PKCS1_SHA256]: {
    id: SIG_ALG.RSA_PKCS1_SHA256,
    digest: 'sha256',
    hash: 'sha256',
  },
  [SIG_ALG.RSA_PKCS1_SHA512]: {
    id: SIG_ALG.RSA_PKCS1_SHA512,
    digest: 'sha512',
    hash: 'sha512',
  },
  [SIG_ALG.ECDSA_SHA256]: {
    id: SIG_ALG.ECDSA_SHA256,
    digest: 'sha256',
    hash: 'sha256',
  },
  [SIG_ALG.ECDSA_SHA512]: {
    id: SIG_ALG.ECDSA_SHA512,
    digest: 'sha512',
    hash: 'sha512',
  },
};

export class ApkSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkSignatureError';
  }
}

/** Pick the algorithm the way Android's own signer does for this key. */
export function algorithmFor(key: KeyObject): AlgorithmInfo {
  if (key.asymmetricKeyType === 'rsa') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 2048;
    return ALGORITHMS[
      bits <= 3072 ? SIG_ALG.RSA_PKCS1_SHA256 : SIG_ALG.RSA_PKCS1_SHA512
    ];
  }
  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    return ALGORITHMS[
      curve === 'prime256v1' || curve === 'P-256'
        ? SIG_ALG.ECDSA_SHA256
        : SIG_ALG.ECDSA_SHA512
    ];
  }
  throw new ApkSignatureError(
    `unsupported signing key type ${key.asymmetricKeyType} (use RSA or EC)`,
  );
}

// ---- byte helpers -----------------------------------------------------------

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
const u64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v), 0);
  return b;
};
/** uint32 length prefix. */
const lp = (data: Buffer) => Buffer.concat([u32(data.length), data]);
/** Length-prefixed sequence of length-prefixed items. */
const lpSeq = (items: Buffer[]) => lp(Buffer.concat(items.map(lp)));

// ---- digests ----------------------------------------------------------------

/**
 * Chunked content digest: each 1 MiB chunk of each section is hashed as
 * H(0xa5 || u32 len || chunk), the result is H(0x5a || u32 count || chunk digests).
 */
export function contentDigest(
  hash: 'sha256' | 'sha512',
  sections: readonly Buffer[],
): Buffer {
  const chunkDigests: Buffer[] = [];
  const prefix = Buffer.alloc(5);
  prefix[0] = 0xa5;
  for (const section of sections) {
    for (let off = 0; off < section.length; off += CHUNK) {
      const chunk = section.subarray(
        off,
        Math.min(section.length, off + CHUNK),
      );
      prefix.writeUInt32LE(chunk.length, 1);
      chunkDigests.push(createHash(hash).update(prefix).update(chunk).digest());
    }
  }
  const head = Buffer.alloc(5);
  head[0] = 0x5a;
  head.writeUInt32LE(chunkDigests.length, 1);
  const top = createHash(hash).update(head);
  for (const d of chunkDigests) top.update(d);
  return top.digest();
}

/** EOCD copy whose central-directory offset field is set to `cdOffset`. */
function eocdWithCdOffset(eocd: Buffer, cdOffset: number): Buffer {
  const copy = Buffer.from(eocd);
  copy.writeUInt32LE(cdOffset, 16);
  return copy;
}

// ---- signing ----------------------------------------------------------------

/** Deterministic signature: RFC 6979 for EC keys, PKCS#1 v1.5 for RSA. */
export function signBytes(
  hash: 'sha256' | 'sha512',
  data: Buffer,
  key: KeyObject,
): Buffer {
  return signEcdsaDeterministic(hash, data, key) ?? cryptoSign(hash, data, key);
}

export interface SignOptions {
  /** v3 signer's SDK range. Defaults: 28 (first platform with v3) .. 0x7fffffff. */
  v3MinSdk?: number;
  v3MaxSdk?: number;
  /** Pad the signing block to a multiple of 4096 bytes (what apksigner does). Default true. */
  pad?: boolean;
}

/**
 * Sign a laid-out ZIP with v2 + v3 and return the APK bytes. The output is
 * deterministic (PKG-9): RSA PKCS#1 v1.5 is by construction, and ECDSA uses
 * RFC 6979 nonces (ecdsa.ts).
 */
export function signApk(
  zip: WrittenZip,
  identity: SigningIdentity,
  options: SignOptions = {},
): Buffer {
  const alg = algorithmFor(identity.privateKey);
  const cdOffset = zip.entries.length;
  const digest = contentDigest(alg.digest, [
    zip.entries,
    zip.centralDirectory,
    eocdWithCdOffset(zip.eocd, cdOffset),
  ]);
  const publicKey = createPublicKey(identity.privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const digests = lpSeq([Buffer.concat([u32(alg.id), lp(digest)])]);
  const certs = lpSeq(identity.certificates);
  const sig = (data: Buffer) =>
    lpSeq([
      Buffer.concat([
        u32(alg.id),
        lp(signBytes(alg.hash, data, identity.privateKey)),
      ]),
    ]);

  // v2
  const v2Attrs = lpSeq([
    Buffer.concat([u32(STRIPPING_PROTECTION_ATTR), u32(3)]),
  ]);
  const v2Signed = Buffer.concat([digests, certs, v2Attrs]);
  const v2Signer = Buffer.concat([lp(v2Signed), sig(v2Signed), lp(publicKey)]);
  const v2Value = lpSeq([v2Signer]);

  // v3
  const minSdk = options.v3MinSdk ?? 28;
  const maxSdk = options.v3MaxSdk ?? 0x7fffffff;
  const v3Signed = Buffer.concat([
    digests,
    certs,
    u32(minSdk),
    u32(maxSdk),
    lpSeq([]),
  ]);
  const v3Signer = Buffer.concat([
    lp(v3Signed),
    u32(minSdk),
    u32(maxSdk),
    sig(v3Signed),
    lp(publicKey),
  ]);
  const v3Value = lpSeq([v3Signer]);

  const block = signingBlock(
    [
      [BLOCK_ID.v2, v2Value],
      [BLOCK_ID.v3, v3Value],
    ],
    options.pad ?? true,
  );
  const finalEocd = eocdWithCdOffset(zip.eocd, cdOffset + block.length);
  return Buffer.concat([zip.entries, block, zip.centralDirectory, finalEocd]);
}

function signingBlock(pairs: [number, Buffer][], pad: boolean): Buffer {
  const encode = (list: [number, Buffer][]) =>
    Buffer.concat(
      list.map(([id, value]) =>
        Buffer.concat([u64(4 + value.length), u32(id), value]),
      ),
    );
  let body = encode(pairs);
  // Total = 8 (leading size) + pairs + 8 (trailing size) + 16 (magic).
  if (pad) {
    const total = 8 + body.length + 8 + 16;
    const rem = total % 4096;
    if (rem !== 0) {
      // A padding pair costs 12 bytes of header plus its zero value.
      let padLen = 4096 - rem - 12;
      if (padLen < 0) padLen += 4096;
      body = encode([...pairs, [BLOCK_ID.verityPadding, Buffer.alloc(padLen)]]);
    }
  }
  const size = body.length + 8 + 16;
  return Buffer.concat([u64(size), body, u64(size), MAGIC]);
}

// ---- verification -----------------------------------------------------------

export interface SignerInfo {
  scheme: 2 | 3;
  algorithm: number;
  certificateSha256: string;
  subject: string;
  minSdk?: number;
  maxSdk?: number;
}

export interface VerifyResult {
  v2: boolean;
  v3: boolean;
  signers: SignerInfo[];
  /** IDs of every pair in the signing block. */
  blockIds: number[];
}

class Reader {
  private buf: Buffer;
  private p = 0;
  private end: number;
  constructor(buf: Buffer) {
    this.buf = buf;
    this.end = buf.length;
  }
  get remaining() {
    return this.end - this.p;
  }
  u32(): number {
    if (this.p + 4 > this.end)
      throw new ApkSignatureError('truncated signature data');
    const v = this.buf.readUInt32LE(this.p);
    this.p += 4;
    return v;
  }
  lp(): Buffer {
    const len = this.u32();
    if (this.p + len > this.end)
      throw new ApkSignatureError('length prefix runs past its container');
    const b = this.buf.subarray(this.p, this.p + len);
    this.p += len;
    return b;
  }
  /** Items of a length-prefixed sequence. */
  seq(): Buffer[] {
    const r = new Reader(this.lp());
    const out: Buffer[] = [];
    while (r.remaining > 0) out.push(r.lp());
    return out;
  }
}

/** Locate the APK Signing Block. Returns its pairs and offsets. */
export function findSigningBlock(apk: Buffer): {
  pairs: Map<number, Buffer>;
  blockOffset: number;
  cdOffset: number;
  ids: number[];
} | null {
  const zip = readZip(apk);
  const cdOffset = zip.centralDirectoryOffset;
  if (cdOffset < 32) return null;
  if (!apk.subarray(cdOffset - 16, cdOffset).equals(MAGIC)) return null;
  const size = Number(apk.readBigUInt64LE(cdOffset - 24));
  const blockOffset = cdOffset - size - 8;
  if (blockOffset < 0 || Number(apk.readBigUInt64LE(blockOffset)) !== size)
    throw new ApkSignatureError('APK Signing Block sizes disagree');
  const pairs = new Map<number, Buffer>();
  const ids: number[] = [];
  let p = blockOffset + 8;
  const end = cdOffset - 24;
  while (p < end) {
    const len = Number(apk.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > end)
      throw new ApkSignatureError('bad pair in APK Signing Block');
    const id = apk.readUInt32LE(p + 8);
    pairs.set(id, apk.subarray(p + 12, p + 8 + len));
    ids.push(id);
    p += 8 + len;
  }
  return { pairs, blockOffset, cdOffset, ids };
}

/**
 * Verify v2 and v3 signatures: signatures over signed data, the content
 * digest, and that the certificate's key is the signer's key. Throws on any
 * failure; returns what was verified.
 */
export function verifyApk(apk: Buffer): VerifyResult {
  const block = findSigningBlock(apk);
  if (!block)
    throw new ApkSignatureError(
      'APK has no APK Signing Block (not v2/v3 signed)',
    );
  const zip = readZip(apk);
  const sections = [
    apk.subarray(0, block.blockOffset),
    apk.subarray(block.cdOffset, zip.eocdOffset),
    eocdWithCdOffset(apk.subarray(zip.eocdOffset), block.blockOffset),
  ];
  const digestCache = new Map<string, Buffer>();
  const digestOf = (hash: 'sha256' | 'sha512') => {
    let d = digestCache.get(hash);
    if (!d) {
      d = contentDigest(hash, sections);
      digestCache.set(hash, d);
    }
    return d;
  };
  const signers: SignerInfo[] = [];
  const verifySigner = (scheme: 2 | 3, signerBytes: Buffer) => {
    const r = new Reader(signerBytes);
    const signedData = r.lp();
    let minSdk: number | undefined;
    let maxSdk: number | undefined;
    if (scheme === 3) {
      minSdk = r.u32();
      maxSdk = r.u32();
    }
    const signatures = r.seq().map((s) => {
      const sr = new Reader(s);
      return { alg: sr.u32(), sig: sr.lp() };
    });
    const publicKeyDer = r.lp();
    const publicKey = createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });
    const supported = signatures.filter((s) => ALGORITHMS[s.alg]);
    if (supported.length === 0)
      throw new ApkSignatureError(
        `v${scheme}: no supported signature algorithm`,
      );
    for (const s of supported) {
      if (!cryptoVerify(ALGORITHMS[s.alg].hash, signedData, publicKey, s.sig))
        throw new ApkSignatureError(`v${scheme}: signature does not verify`);
    }
    const sd = new Reader(signedData);
    const digests = sd.seq().map((d) => {
      const dr = new Reader(d);
      return { alg: dr.u32(), digest: dr.lp() };
    });
    const certs = sd.seq();
    if (scheme === 3) {
      const sdMin = sd.u32();
      const sdMax = sd.u32();
      if (sdMin !== minSdk || sdMax !== maxSdk)
        throw new ApkSignatureError('v3: SDK range mismatch');
    }
    const attrs = sd.seq().map((a) => {
      const ar = new Reader(a);
      return { id: ar.u32(), value: a.subarray(4) };
    });
    const sigAlgs = signatures.map((s) => s.alg).sort();
    const digAlgs = digests.map((d) => d.alg).sort();
    if (sigAlgs.join() !== digAlgs.join())
      throw new ApkSignatureError(
        `v${scheme}: signature and digest algorithm lists differ`,
      );
    for (const d of digests) {
      const info = ALGORITHMS[d.alg];
      if (!info) continue;
      if (!digestOf(info.digest).equals(d.digest))
        throw new ApkSignatureError(
          `v${scheme}: APK contents digest mismatch (the file was modified after signing)`,
        );
    }
    if (certs.length === 0)
      throw new ApkSignatureError(`v${scheme}: no certificate`);
    const cert = new X509Certificate(certs[0]);
    if (
      !cert.publicKey
        .export({ type: 'spki', format: 'der' })
        .equals(publicKeyDer)
    )
      throw new ApkSignatureError(
        `v${scheme}: certificate key differs from the signer key`,
      );
    if (scheme === 2 && block.pairs.has(BLOCK_ID.v3)) {
      const strip = attrs.find((a) => a.id === STRIPPING_PROTECTION_ATTR);
      if (strip && strip.value.readUInt32LE(0) !== 3)
        throw new ApkSignatureError(
          'v2: unexpected stripping-protection scheme',
        );
    }
    signers.push({
      scheme,
      algorithm: supported[0].alg,
      certificateSha256: cert.fingerprint256,
      subject: cert.subject.replace(/\n/g, ', '),
      ...(scheme === 3 ? { minSdk, maxSdk } : {}),
    });
  };
  const v2 = block.pairs.get(BLOCK_ID.v2);
  const v3 = block.pairs.get(BLOCK_ID.v3);
  if (v2) for (const s of new Reader(v2).seq()) verifySigner(2, s);
  if (v3) for (const s of new Reader(v3).seq()) verifySigner(3, s);
  if (!v2 && !v3)
    throw new ApkSignatureError('APK Signing Block has no v2 or v3 signature');
  return { v2: !!v2, v3: !!v3, signers, blockIds: block.ids };
}
