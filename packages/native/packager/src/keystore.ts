/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Read a release keystore (PKG-7) without Java: PKCS#12 (RFC 7292) as
 * current tools write it (keytool from JDK 12, 11.0.12 and 8u301; OpenSSL 3):
 * password-integrity MAC (HMAC with the PKCS#12 KDF, SHA-1/SHA-2), shrouded
 * key bags and encrypted cert bags with PBES2 (PBKDF2 + AES, RFC 8018).
 * All decryption is node:crypto's.
 *
 * Older formats are refused with the keytool command that converts them
 * (same key, so store updates still verify): JKS, JCEKS and PKCS#12 files
 * encrypted with the legacy PKCS#12 PBE schemes (3DES, RC2).
 *
 * Passwords are only ever held in memory and never appear in messages.
 */

import {
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  pbkdf2Sync,
  timingSafeEqual,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  decode,
  expect,
  readBmp,
  readInt,
  readOctets,
  readOid,
  TAG,
  type DerNode,
} from './der.ts';
import type { SigningIdentity } from './signing-key.ts';

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

interface KeyEntry {
  alias: string | null;
  localKeyId: string | null;
  /**
   * Decrypt and return the PKCS#8 PrivateKeyInfo DER. Deferred so that only
   * the selected alias is decrypted: keys of other aliases may have their own
   * passwords.
   */
  unlock: () => Buffer;
}
interface CertEntry {
  alias: string | null;
  localKeyId: string | null;
  der: Buffer;
}

const P12 = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  /** The legacy PKCS#12 PBE schemes (3DES, 2DES, RC2-128, RC2-40) are 1.2.840.113549.1.12.1.3..6. */
  legacyPbePrefix: '1.2.840.113549.1.12.1.',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
} as const;

const HASHES: Record<string, { name: string; v: number }> = {
  '1.3.14.3.2.26': { name: 'sha1', v: 64 },
  '2.16.840.1.101.3.4.2.1': { name: 'sha256', v: 64 },
  '2.16.840.1.101.3.4.2.2': { name: 'sha384', v: 128 },
  '2.16.840.1.101.3.4.2.3': { name: 'sha512', v: 128 },
  '2.16.840.1.101.3.4.2.4': { name: 'sha224', v: 64 },
};
const HMAC_PRF: Record<string, string> = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512',
};
const CIPHERS: Record<string, { name: string; keyLen: number }> = {
  '2.16.840.1.101.3.4.1.2': { name: 'aes-128-cbc', keyLen: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'aes-192-cbc', keyLen: 24 },
  '2.16.840.1.101.3.4.1.42': { name: 'aes-256-cbc', keyLen: 32 },
};

/** Stands in for the keystore path in messages thrown below loadKeystoreIdentity, which fills it in. */
const KEYSTORE_PATH = '<keystore>';
const convert = (file = KEYSTORE_PATH) =>
  'Convert the keystore with keytool from JDK 17 or later (the key stays the same): ' +
  `keytool -importkeystore -srckeystore ${file} -destkeystore release.p12 -deststoretype pkcs12`;
const LEGACY_PKCS12 = `this PKCS#12 keystore uses legacy encryption (3DES or RC2), which is not supported. ${convert()}`;

/** PKCS#12 password: BMPString (UTF-16BE) with a two-byte NUL terminator (RFC 7292 B.1). */
function bmpPassword(password: string): Buffer {
  const out = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++)
    out.writeUInt16BE(password.charCodeAt(i), i * 2);
  return out;
}

/** RFC 7292 appendix B.2 key derivation. id: 1 key, 2 IV, 3 MAC key. */
export function pkcs12Kdf(
  hash: string,
  v: number,
  password: Buffer,
  salt: Buffer,
  iterations: number,
  id: number,
  length: number,
): Buffer {
  const D = Buffer.alloc(v, id);
  const fill = (src: Buffer) => {
    if (src.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
    return out;
  };
  const I = Buffer.concat([fill(salt), fill(password)]);
  const result: Buffer[] = [];
  let produced = 0;
  while (produced < length) {
    let A = createHash(hash).update(D).update(I).digest();
    for (let i = 1; i < iterations; i++)
      A = createHash(hash).update(A).digest();
    result.push(A);
    produced += A.length;
    if (produced >= length) break;
    const B = Buffer.alloc(v);
    for (let i = 0; i < v; i++) B[i] = A[i % A.length];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(result).subarray(0, length);
}

function decryptWithAlgorithm(
  algId: DerNode,
  data: Buffer,
  password: string,
): Buffer {
  const algOid = readOid(algId.children[0], 'encryption algorithm');
  const params = algId.children[1];
  const fail = (e: unknown): never => {
    throw new KeystoreError(
      `cannot decrypt the keystore (wrong password?): ${(e as Error).message}`,
    );
  };
  if (algOid === P12.pbes2) {
    const kdf = expect(params?.children[0], TAG.SEQUENCE, 'PBES2 kdf');
    const enc = expect(params?.children[1], TAG.SEQUENCE, 'PBES2 cipher');
    if (readOid(kdf.children[0]) !== P12.pbkdf2)
      throw new KeystoreError('PBES2: only PBKDF2 is supported');
    const kp = kdf.children[1].children;
    const salt = readOctets(kp[0], 'PBKDF2 salt');
    const iterations = Number(readInt(kp[1], 'PBKDF2 iterations'));
    let keyLength: number | null = null;
    let prf = 'sha1';
    for (const extra of kp.slice(2)) {
      if (extra.tag === TAG.INTEGER) keyLength = Number(readInt(extra));
      else if (extra.tag === TAG.SEQUENCE) {
        const name = HMAC_PRF[readOid(extra.children[0])];
        if (!name) throw new KeystoreError('PBKDF2: unsupported PRF');
        prf = name;
      }
    }
    const cipher = CIPHERS[readOid(enc.children[0])];
    if (!cipher)
      throw new KeystoreError(`PBES2: unsupported cipher. ${convert()}`);
    const iv = readOctets(enc.children[1], 'PBES2 IV');
    const key = pbkdf2Sync(
      Buffer.from(password, 'utf8'),
      salt,
      iterations,
      keyLength ?? cipher.keyLen,
      prf,
    );
    try {
      const d = createDecipheriv(cipher.name, key, iv);
      return Buffer.concat([d.update(data), d.final()]);
    } catch (e) {
      return fail(e);
    }
  }
  if (algOid.startsWith(P12.legacyPbePrefix))
    throw new KeystoreError(LEGACY_PKCS12);
  throw new KeystoreError(`unsupported keystore encryption ${algOid}`);
}

function bagAttributes(node: DerNode | undefined): {
  alias: string | null;
  localKeyId: string | null;
} {
  let alias: string | null = null;
  let localKeyId: string | null = null;
  for (const attr of node?.children ?? []) {
    const type = readOid(attr.children[0]);
    const value = attr.children[1]?.children[0];
    if (!value) continue;
    if (type === P12.friendlyName && value.tag === TAG.BMP_STRING)
      alias = readBmp(value);
    if (type === P12.localKeyId) localKeyId = readOctets(value).toString('hex');
  }
  return { alias, localKeyId };
}

/** Decode a PKCS#12 file into its private keys and certificates. */
export function readPkcs12(
  buffer: Buffer,
  storePassword: string,
  keyPassword = storePassword,
): {
  keys: KeyEntry[];
  certs: CertEntry[];
} {
  let pfx: DerNode;
  try {
    pfx = decode(buffer);
  } catch (e) {
    throw new KeystoreError(`not a PKCS#12 keystore: ${(e as Error).message}`);
  }
  const [version, authSafe, macData] = pfx.children;
  if (readInt(version, 'PFX version') !== 3n)
    throw new KeystoreError('unsupported PKCS#12 version');
  if (readOid(authSafe.children[0]) !== P12.data)
    throw new KeystoreError(
      'PKCS#12 with public-key integrity is not supported',
    );
  const authContent = readOctets(
    authSafe.children[1]?.children[0],
    'authSafe content',
  );

  if (macData) {
    const digestInfo = macData.children[0];
    const macAlg = digestInfo.children[0];
    const macOid = readOid(macAlg.children[0]);
    if (macOid === P12.pbmac1)
      throw new KeystoreError(
        'PKCS#12 PBMAC1 integrity is not supported yet; re-export the keystore with a classic MAC',
      );
    const hash = HASHES[macOid];
    if (!hash)
      throw new KeystoreError(`unsupported PKCS#12 MAC digest ${macOid}`);
    const expected = readOctets(digestInfo.children[1]);
    const salt = readOctets(macData.children[1]);
    const iterations = macData.children[2]
      ? Number(readInt(macData.children[2]))
      : 1;
    const hashLen = createHash(hash.name).digest().length;
    const key = pkcs12Kdf(
      hash.name,
      hash.v,
      bmpPassword(storePassword),
      salt,
      iterations,
      3,
      hashLen,
    );
    const actual = createHmac(hash.name, key).update(authContent).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new KeystoreError(
        'keystore password is wrong (PKCS#12 integrity check failed)',
      );
  }

  const keys: KeyEntry[] = [];
  const certs: CertEntry[] = [];
  const safe = decode(authContent);
  for (const contentInfo of safe.children) {
    const type = readOid(contentInfo.children[0]);
    let safeContents: Buffer;
    if (type === P12.data)
      safeContents = readOctets(contentInfo.children[1]?.children[0]);
    else if (type === P12.encryptedData) {
      const encryptedData = contentInfo.children[1].children[0];
      const eci = encryptedData.children[1];
      const enc = eci.children[2];
      if (!enc) continue; // no content
      safeContents = decryptWithAlgorithm(
        eci.children[1],
        readOctets(enc),
        storePassword,
      );
    } else throw new KeystoreError(`unsupported PKCS#12 content type ${type}`);
    for (const bag of decode(safeContents).children) {
      const bagId = readOid(bag.children[0]);
      const value = bag.children[1]?.children[0];
      const attrs = bagAttributes(bag.children[2]);
      if (!value) continue;
      if (bagId === P12.keyBag) {
        const raw = value.raw;
        keys.push({ ...attrs, unlock: () => raw });
      } else if (bagId === P12.shroudedKeyBag) {
        const algId = value.children[0];
        const data = readOctets(value.children[1]);
        keys.push({
          ...attrs,
          unlock: () => {
            try {
              return decryptWithAlgorithm(algId, data, keyPassword);
            } catch (e) {
              if (keyPassword === storePassword) throw e;
              try {
                return decryptWithAlgorithm(algId, data, storePassword);
              } catch {
                throw new KeystoreError(
                  'key password is wrong (cannot decrypt the PKCS#12 key)',
                );
              }
            }
          },
        });
      } else if (bagId === P12.certBag) {
        if (readOid(value.children[0]) !== P12.x509Certificate) continue;
        certs.push({
          ...attrs,
          der: readOctets(value.children[1]?.children[0]),
        });
      }
    }
  }
  return { keys, certs };
}

const JKS_MAGIC = 0xfeedfeed;
const JCEKS_MAGIC = 0xcececece;

// ---- loading ----------------------------------------------------------------

export interface KeystoreOptions {
  storePassword: string;
  keyPassword?: string;
  /** Key alias; null picks the keystore's only private key. */
  alias?: string | null;
  /** For messages. */
  description?: string;
  /** The keystore's path, for the conversion command in messages. */
  file?: string;
}

export function keystoreFormat(
  buffer: Buffer,
): 'jks' | 'jceks' | 'pkcs12' | 'unknown' {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === JKS_MAGIC) return 'jks';
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === JCEKS_MAGIC)
    return 'jceks';
  if (buffer.length >= 2 && buffer[0] === 0x30) return 'pkcs12';
  return 'unknown';
}

/** Load a signing identity from a PKCS#12 keystore. */
export function loadKeystoreIdentity(
  buffer: Buffer,
  options: KeystoreOptions,
): SigningIdentity {
  const format = keystoreFormat(buffer);
  const where = options.description ?? 'keystore';
  if (format === 'jks' || format === 'jceks')
    throw new KeystoreError(
      `${where}: ${format.toUpperCase()} keystores are not supported, only PKCS#12. ${convert(options.file)}`,
    );
  if (format === 'unknown')
    throw new KeystoreError(`${where}: not a PKCS#12 keystore`);
  const located = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof KeystoreError)
        e.message = `${where}: ${e.message.replace(KEYSTORE_PATH, options.file ?? KEYSTORE_PATH)}`;
      throw e;
    }
  };
  const { keys, certs } = located(() =>
    readPkcs12(buffer, options.storePassword, options.keyPassword),
  );
  if (keys.length === 0)
    throw new KeystoreError(`${where}: no private key in the keystore`);
  let key: KeyEntry | undefined;
  const aliases = keys.map((k) => k.alias ?? '(unnamed)');
  if (options.alias) {
    key = keys.find(
      (k) => k.alias?.toLowerCase() === options.alias!.toLowerCase(),
    );
    if (!key)
      throw new KeystoreError(
        `${where}: no key with alias "${options.alias}" (aliases: ${aliases.join(', ')})`,
      );
  } else {
    if (keys.length > 1)
      throw new KeystoreError(
        `${where}: several keys (${aliases.join(', ')}); set "keyAlias" in the signing config`,
      );
    key = keys[0];
  }
  const chain = certs.filter((c) =>
    key!.localKeyId !== null && c.localKeyId !== null
      ? c.localKeyId === key!.localKeyId
      : key!.alias !== null && c.alias === key!.alias,
  );
  const candidates = chain.length > 0 ? chain : certs;
  const pkcs8 = located(key.unlock);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch (e) {
    throw new KeystoreError(
      `${where}: cannot read the private key: ${(e as Error).message}`,
    );
  }
  const ordered = orderChain(
    candidates.map((c) => c.der),
    privateKey,
  );
  if (ordered.length === 0)
    throw new KeystoreError(`${where}: no certificate matches the private key`);
  return {
    privateKey,
    certificates: ordered,
    description: `${where}${key.alias ? ` alias ${key.alias}` : ''}`,
  };
}

/** Put the certificate whose public key matches the private key first. */
function orderChain(ders: Buffer[], privateKey: KeyObject): Buffer[] {
  const want = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const leafIndex = ders.findIndex((d) =>
    new X509Certificate(d).publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(want),
  );
  if (leafIndex < 0) return [];
  const rest = ders.filter((_, i) => i !== leafIndex);
  return [ders[leafIndex], ...rest];
}

export function loadKeystoreFile(
  file: string,
  options: KeystoreOptions,
): SigningIdentity {
  return loadKeystoreIdentity(readFileSync(file), {
    description: `keystore ${file}`,
    file: /\s/.test(file) ? JSON.stringify(file) : file,
    ...options,
  });
}
