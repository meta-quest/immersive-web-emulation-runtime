/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Signing identities: the per-machine debug key (PKG-7, generated on first
 * use in the user's config directory) and self-signed X.509 certificates
 * (RFC 5280) for it.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bits,
  explicit,
  int,
  nul,
  oid,
  printable,
  seq,
  set,
  time,
} from './der.ts';
import { signEcdsaDeterministic } from './ecdsa.ts';

/** A signing key the user has to fix (corrupt, mismatched, unsupported). */
export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

/** A private key and its certificate chain (leaf first). */
export interface SigningIdentity {
  privateKey: KeyObject;
  /** DER certificates, signer's own first. */
  certificates: Buffer[];
  /** Where it came from, for messages ("debug key ~/.config/…", "keystore x.p12 alias y"). */
  description: string;
}

export const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  commonName: '2.5.4.3',
} as const;

export interface CertificateSubject {
  commonName: string;
  organization?: string;
  country?: string;
}

/** Build a self-signed v3 certificate for an RSA or EC (P-256) key. */
export function selfSignedCertificate(
  privateKey: KeyObject,
  subject: CertificateSubject,
  options: { notBefore: Date; notAfter: Date; serial?: Buffer },
): Buffer {
  const keyType = privateKey.asymmetricKeyType;
  let sigAlg: Buffer;
  let hash: string;
  if (keyType === 'rsa') {
    sigAlg = seq(oid(OID.sha256WithRSA), nul());
    hash = 'sha256';
  } else if (keyType === 'ec') {
    sigAlg = seq(oid(OID.ecdsaWithSHA256));
    hash = 'sha256';
  } else throw new Error(`unsupported key type for a certificate: ${keyType}`);
  const rdn = (o: string, value: Buffer) => set(seq(oid(o), value));
  const name = seq(
    ...(subject.country
      ? [rdn(OID.countryName, printable(subject.country))]
      : []),
    ...(subject.organization
      ? [rdn(OID.organizationName, printable(subject.organization))]
      : []),
    rdn(OID.commonName, printable(subject.commonName)),
  );
  const serial = options.serial ?? randomBytes(8);
  serial[0] &= 0x7f; // positive
  const spki = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const tbs = seq(
    explicit(0, int(2)), // v3
    int(serial),
    sigAlg,
    name,
    seq(time(options.notBefore), time(options.notAfter)),
    name,
    spki,
  );
  const signature =
    signEcdsaDeterministic('sha256', tbs, privateKey) ??
    cryptoSign(hash, tbs, privateKey);
  return seq(tbs, sigAlg, bits(signature));
}

/** The user's config directory for this tool (never the project). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IWER_NATIVE_CONFIG_DIR) return env.IWER_NATIVE_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA)
    return path.join(env.APPDATA, 'iwer-native');
  if (process.platform === 'darwin')
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'iwer-native',
    );
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'iwer-native',
  );
}

export const DEBUG_SUBJECT: CertificateSubject = {
  commonName: 'Android Debug',
  organization: 'Android',
  country: 'US',
};

/**
 * Load the per-machine debug key, generating it (RSA 2048, 30-year
 * self-signed certificate, like the Android SDK's debug keystore) on first
 * use. Files: `<config>/debug-key/key.pem` (PKCS#8, mode 0600) and `cert.pem`.
 *
 * Safe under concurrent first use: the key and certificate are written into
 * a private temporary directory that is renamed to `debug-key/` in one step.
 * Renaming onto an existing non-empty directory fails, so exactly one
 * process's key wins; the others discard theirs and load the winner's, and
 * every caller signs with the key that stays on disk.
 */
export function loadOrCreateDebugIdentity(
  options: { configDir?: string; now?: Date } = {},
): SigningIdentity & { created: boolean; dir: string } {
  const configDir = options.configDir ?? userConfigDir();
  const dir = path.join(configDir, 'debug-key');
  if (existsSync(dir)) return loadDebugIdentity(dir);

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = options.now ?? new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 30);
  const der = selfSignedCertificate(privateKey, DEBUG_SUBJECT, {
    notBefore,
    notAfter,
  });
  const pem = (label: string, data: Buffer) =>
    `-----BEGIN ${label}-----\n${data
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .replace(/\n$/, '')}\n-----END ${label}-----\n`;
  const tmp = mkdtempSync(path.join(configDir, '.debug-key-')); // mode 0700
  try {
    writeFileSync(
      path.join(tmp, 'key.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      { mode: 0o600 },
    );
    writeFileSync(path.join(tmp, 'cert.pem'), pem('CERTIFICATE', der));
    try {
      renameSync(tmp, dir);
    } catch (e) {
      // Another process created debug-key/ first: use its key.
      if (existsSync(dir)) return loadDebugIdentity(dir);
      throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    privateKey,
    certificates: [der],
    description: `debug key ${dir} (created)`,
    created: true,
    dir,
  };
}

function loadDebugIdentity(
  dir: string,
): SigningIdentity & { created: boolean; dir: string } {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const broken = (why: string) =>
    new SigningKeyError(
      [
        `the debug signing key in ${dir} is unusable: ${why}.`,
        'Delete that directory to create a new debug key. Apps installed with the old key must then be',
        'uninstalled once (Android refuses updates signed with another key).',
      ].join('\n'),
    );
  if (!existsSync(keyFile) || !existsSync(certFile))
    throw broken('key.pem or cert.pem is missing');
  let identity: SigningIdentity;
  try {
    identity = {
      privateKey: createPrivateKey(readFileSync(keyFile)),
      certificates: [new X509Certificate(readFileSync(certFile)).raw],
      description: `debug key ${dir}`,
    };
  } catch (e) {
    throw broken(`cannot read it (${(e as Error).message})`);
  }
  try {
    checkIdentity(identity);
  } catch (e) {
    throw broken((e as Error).message.replace(/^.*?: /, ''));
  }
  return { ...identity, created: false, dir };
}

/**
 * Throw unless the identity can sign APKs: a supported key type (RSA, or EC
 * on P-256/P-384/P-521) whose public key matches the leaf certificate.
 */
export function checkIdentity(identity: SigningIdentity): void {
  if (identity.certificates.length === 0)
    throw new SigningKeyError(`${identity.description}: no certificate`);
  const key = identity.privateKey;
  const type = key.asymmetricKeyType;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (
    type !== 'rsa' &&
    !(
      type === 'ec' &&
      ['prime256v1', 'secp384r1', 'secp521r1', 'P-256', 'P-384', 'P-521'].includes(
        curve ?? '',
      )
    )
  )
    throw new SigningKeyError(
      `${identity.description}: unsupported signing key type ${type}${curve ? ` (${curve})` : ''}; APK signing needs RSA or EC P-256/P-384/P-521`,
    );
  let fromCert: Buffer;
  try {
    fromCert = new X509Certificate(identity.certificates[0]).publicKey.export({
      type: 'spki',
      format: 'der',
    });
  } catch (e) {
    throw new SigningKeyError(
      `${identity.description}: cannot read the certificate (${(e as Error).message})`,
    );
  }
  const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!fromCert.equals(fromKey))
    throw new SigningKeyError(
      `${identity.description}: the private key does not match the certificate`,
    );
}

/** SHA-256 fingerprint of the signer certificate, for messages. */
export function certificateFingerprint(identity: SigningIdentity): string {
  return new X509Certificate(identity.certificates[0]).fingerprint256;
}
