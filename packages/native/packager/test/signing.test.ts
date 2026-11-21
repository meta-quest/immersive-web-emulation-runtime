/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  verify as cryptoVerify,
  X509Certificate,
} from 'node:crypto';
import {
  copyFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  BLOCK_ID,
  findSigningBlock,
  signApk,
  verifyApk,
  SIG_ALG,
} from '../src/apk-sign.ts';
import { loadKeystoreFile, pkcs12Kdf } from '../src/keystore.ts';
import { decode, readInt } from '../src/der.ts';
import { signEcdsaDeterministic } from '../src/ecdsa.ts';
import {
  certificateFingerprint,
  checkIdentity,
  loadOrCreateDebugIdentity,
} from '../src/signing-key.ts';
import { prepareEntry, writeZip } from '../src/zip.ts';
import { FIXTURES, scratchDir, STORE_PASSWORD } from './helpers.ts';

const scratch = scratchDir('signing');
after(() => rmSync(scratch, { recursive: true, force: true }));

const fixture = (f: string) => path.join(FIXTURES, f);

describe('keystores (PKG-7)', () => {
  const cases: [string, string, Record<string, string>][] = [
    ['p12-jdk17.p12', 'keytool 17 PKCS#12 (PBES2 AES-256, HMAC-SHA256)', {}],
    [
      'p12-jdk8.p12',
      'keytool 8 PKCS#12 (3DES key, RC2-40 certs, HMAC-SHA1)',
      {},
    ],
    ['openssl3.p12', 'OpenSSL 3 PKCS#12 (PBES2 everywhere)', {}],
    ['openssl-3des.p12', 'OpenSSL PKCS#12 with 3DES and a SHA-1 MAC', {}],
    ['ec-jdk17.p12', 'EC P-256 key', {}],
    [
      'jdk8.jks',
      'JKS with a separate key password',
      { keyPassword: 'iwn-test-key', alias: 'upload' },
    ],
  ];
  for (const [file, what, extra] of cases) {
    test(what, () => {
      const id = loadKeystoreFile(fixture(file), {
        storePassword: STORE_PASSWORD,
        ...extra,
      });
      checkIdentity(id);
      assert.match(
        new X509Certificate(id.certificates[0]).subject,
        /iwer-native test/,
      );
    });
  }
  test('wrong store password', () => {
    assert.throws(
      () =>
        loadKeystoreFile(fixture('p12-jdk17.p12'), { storePassword: 'nope' }),
      /password is wrong/,
    );
    assert.throws(
      () => loadKeystoreFile(fixture('jdk8.jks'), { storePassword: 'nope' }),
      /password is wrong/,
    );
  });
  test('wrong JKS key password', () => {
    assert.throws(
      () =>
        loadKeystoreFile(fixture('jdk8.jks'), {
          storePassword: STORE_PASSWORD,
          keyPassword: 'nope',
          alias: 'upload',
        }),
      /key password is wrong/,
    );
  });
  test('several keys need an alias; unknown alias lists the aliases', () => {
    assert.throws(
      () =>
        loadKeystoreFile(fixture('jdk8.jks'), {
          storePassword: STORE_PASSWORD,
          keyPassword: 'iwn-test-key',
        }),
      /several keys \(.*upload.*\); set "keyAlias"/,
    );
    assert.throws(
      () =>
        loadKeystoreFile(fixture('p12-jdk17.p12'), {
          storePassword: STORE_PASSWORD,
          alias: 'missing',
        }),
      /no key with alias "missing" \(aliases: upload\)/,
    );
  });
  test('messages never contain the password', () => {
    try {
      loadKeystoreFile(fixture('p12-jdk17.p12'), {
        storePassword: 'hunter2-secret',
      });
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /hunter2/);
    }
  });
  test('PKCS#12 KDF is stable', () => {
    const pw = Buffer.from('\0s\0m\0e\0g\0\0', 'latin1');
    const k = pkcs12Kdf(
      'sha1',
      64,
      pw,
      Buffer.from('0a58cf64530d823f', 'hex'),
      1,
      1,
      24,
    );
    // RFC 7292 does not ship vectors; this one is the widely published "smeg" vector.
    assert.equal(
      k.toString('hex'),
      '8aaae6297b6cb04642ab5b077851284eb7128f1a2a7fbca3',
    );
  });
});

describe('debug key', () => {
  test('created once, then reused; private key file is 0600', () => {
    const dir = path.join(scratch, 'cfg');
    const a = loadOrCreateDebugIdentity({ configDir: dir });
    assert.equal(a.created, true);
    const b = loadOrCreateDebugIdentity({ configDir: dir });
    assert.equal(b.created, false);
    assert.deepEqual(a.certificates[0], b.certificates[0]);
    checkIdentity(b);
    const cert = new X509Certificate(b.certificates[0]);
    assert.match(cert.subject, /CN=Android Debug/);
    assert.ok(
      new Date(cert.validTo).getUTCFullYear() - new Date().getUTCFullYear() >=
        29,
    );
    if (process.platform !== 'win32')
      assert.equal(
        statSync(path.join(dir, 'debug-key', 'key.pem')).mode & 0o777,
        0o600,
      );
  });
  test('concurrent first use: every process signs with the key that stays on disk', async () => {
    const dir = path.join(scratch, 'race');
    const mod = pathToFileURL(
      path.join(import.meta.dirname, '..', 'src', 'signing-key.ts'),
    ).href;
    const script = `const m = await import(${JSON.stringify(mod)});
const id = m.loadOrCreateDebugIdentity({ configDir: ${JSON.stringify(dir)} });
process.stdout.write(JSON.stringify({ created: id.created, fp: m.certificateFingerprint(id) }));`;
    const run = () =>
      new Promise<{ created: boolean; fp: string }>((resolve, reject) =>
        execFile(
          process.execPath,
          ['--input-type=module', '-e', script],
          (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))),
        ),
      );
    const results = await Promise.all(Array.from({ length: 8 }, run));
    const onDisk = loadOrCreateDebugIdentity({ configDir: dir });
    assert.equal(onDisk.created, false);
    const fp = certificateFingerprint(onDisk);
    assert.deepEqual(
      results.map((r) => r.fp),
      Array(8).fill(fp),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f !== 'debug-key'),
      [],
      'no temporary directories left',
    );
  });
  test('a mismatched or corrupt key says which directory to delete', () => {
    const a = path.join(scratch, 'mm-a');
    const b = path.join(scratch, 'mm-b');
    loadOrCreateDebugIdentity({ configDir: a });
    loadOrCreateDebugIdentity({ configDir: b });
    copyFileSync(
      path.join(b, 'debug-key', 'key.pem'),
      path.join(a, 'debug-key', 'key.pem'),
    );
    assert.throws(
      () => loadOrCreateDebugIdentity({ configDir: a }),
      (e: Error) =>
        e.name === 'SigningKeyError' &&
        /does not match the certificate/.test(e.message) &&
        e.message.includes(path.join(a, 'debug-key')) &&
        /Delete that directory/.test(e.message),
    );
    writeFileSync(path.join(b, 'debug-key', 'key.pem'), 'garbage');
    assert.throws(
      () => loadOrCreateDebugIdentity({ configDir: b }),
      /unusable: cannot read it[\s\S]*Delete that directory/,
    );
  });
  test('unsupported key types are refused by checkIdentity (before packing)', () => {
    const rsa = loadOrCreateDebugIdentity({ configDir: path.join(scratch, 'rsa') });
    for (const type of ['dsa', 'ed25519'] as const) {
      const { privateKey } =
        type === 'dsa'
          ? generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 })
          : generateKeyPairSync('ed25519');
      assert.throws(
        () =>
          checkIdentity({
            privateKey,
            certificates: rsa.certificates,
            description: type,
          }),
        new RegExp(`unsupported signing key type ${type}`),
      );
    }
  });
});

describe('deterministic ECDSA (RFC 6979)', () => {
  test('RFC 6979 A.2.5 P-256/SHA-256 "sample" vector', () => {
    const d = Buffer.from(
      'C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721',
      'hex',
    );
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: d.toString('base64url'),
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
    });
    const sig = signEcdsaDeterministic('sha256', Buffer.from('sample'), key)!;
    const node = decode(sig);
    assert.equal(
      readInt(node.children[0]).toString(16),
      'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716',
    );
    assert.equal(
      readInt(node.children[1]).toString(16),
      'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8',
    );
  });
  test('P-384 and P-521 sign, verify and repeat', () => {
    for (const curve of ['secp384r1', 'secp521r1']) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: curve,
      });
      const data = Buffer.from(`hello ${curve}`);
      const a = signEcdsaDeterministic('sha512', data, privateKey)!;
      assert.deepEqual(signEcdsaDeterministic('sha512', data, privateKey), a);
      assert.ok(cryptoVerify('sha512', data, publicKey, a), curve);
    }
  });
  test('EC-signed APKs are byte-identical (PKG-9)', async () => {
    const id = loadKeystoreFile(fixture('ec-jdk17.p12'), {
      storePassword: STORE_PASSWORD,
    });
    const z = await writeZip([
      await prepareEntry('assets/a.txt', Buffer.from('x'.repeat(5000)), {
        compress: true,
      }),
    ]);
    const apk = signApk(z, id);
    assert.deepEqual(signApk(z, id), apk);
    verifyApk(apk);
  });
});

describe('APK Signature Scheme v2 + v3', () => {
  const zipOf = async (n = 3) => {
    const entries = [];
    for (let i = 0; i < n; i++)
      entries.push(
        await prepareEntry(`assets/f${i}.bin`, Buffer.alloc(700_000 + i, i), {
          compress: i % 2 === 0,
        }),
      );
    return writeZip(entries);
  };
  test('RSA: verifies, deterministic, block padded to 4096', async () => {
    const id = loadOrCreateDebugIdentity({
      configDir: path.join(scratch, 'rsa'),
    });
    const z = await zipOf();
    const apk = signApk(z, id);
    assert.deepEqual(
      signApk(z, id),
      apk,
      'PKCS#1 v1.5 signatures are deterministic',
    );
    const r = verifyApk(apk);
    assert.equal(r.v2, true);
    assert.equal(r.v3, true);
    assert.equal(r.signers[0].algorithm, SIG_ALG.RSA_PKCS1_SHA256);
    assert.equal(r.signers[1].minSdk, 28);
    const block = findSigningBlock(apk)!;
    assert.equal((block.cdOffset - block.blockOffset) % 4096, 0);
    assert.deepEqual(block.ids, [
      BLOCK_ID.v2,
      BLOCK_ID.v3,
      BLOCK_ID.verityPadding,
    ]);
  });
  test('EC P-256 (ECDSA) from a keystore', async () => {
    const id = loadKeystoreFile(fixture('ec-jdk17.p12'), {
      storePassword: STORE_PASSWORD,
    });
    const r = verifyApk(signApk(await zipOf(1), id));
    assert.equal(r.signers[0].algorithm, SIG_ALG.ECDSA_SHA256);
  });
  test('any modified byte breaks verification', async () => {
    const id = loadOrCreateDebugIdentity({
      configDir: path.join(scratch, 'rsa'),
    });
    const apk = signApk(await zipOf(), id);
    const block = findSigningBlock(apk)!;
    // an entry header, entry data, the central directory, the EOCD
    for (const at of [10, 300_000, block.cdOffset + 5, apk.length - 10]) {
      const copy = Buffer.from(apk);
      copy[at] ^= 1;
      assert.throws(() => verifyApk(copy), Error, `byte ${at}`);
    }
  });
  test('unsigned APK is rejected', async () => {
    const z = await zipOf(1);
    assert.throws(
      () => verifyApk(Buffer.concat([z.entries, z.centralDirectory, z.eocd])),
      /no APK Signing Block/,
    );
  });
  test('signer cert in the APK is the keystore certificate', async () => {
    const id = loadKeystoreFile(fixture('p12-jdk8.p12'), {
      storePassword: STORE_PASSWORD,
    });
    const r = verifyApk(signApk(await zipOf(1), id));
    assert.equal(
      r.signers[0].certificateSha256,
      new X509Certificate(id.certificates[0]).fingerprint256,
    );
    assert.equal(readFileSync(fixture('p12-jdk8.p12')).length > 0, true);
  });
});
