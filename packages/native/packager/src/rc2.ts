/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * RC2 block cipher (RFC 2268), CBC decrypt only (plus block encrypt for the
 * RFC test vectors). Needed because older PKCS#12 files (keytool before
 * JDK 12, OpenSSL < 3 defaults) encrypt their certificate bag with
 * pbeWithSHAAnd40BitRC2-CBC, and OpenSSL 3 only offers RC2 in its legacy
 * provider, which Node does not load.
 */

// RFC 2268 section 2: PITABLE, a permutation of 0..255 derived from pi.
const PITABLE = Buffer.from(
  'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2' +
    '179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e82' +
    '54d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626' +
    '6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed7' +
    '08e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ec' +
    'c2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731' +
    '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a9' +
    '0d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad',
  'hex',
);

/** Expand a key to 64 16-bit subkeys with the given effective key bits. */
export function rc2Expand(key: Buffer, effectiveBits: number): Uint16Array {
  const T = key.length;
  if (T < 1 || T > 128) throw new Error('RC2 key must be 1..128 bytes');
  const L = new Uint8Array(128);
  L.set(key);
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  const T8 = Math.ceil(effectiveBits / 8);
  const TM = 0xff >> (8 * T8 - effectiveBits);
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}

const S = [1, 2, 3, 5];

export function rc2EncryptBlock(K: Uint16Array, block: Buffer): Buffer {
  const R = [0, 1, 2, 3].map((i) => block.readUInt16LE(i * 2));
  let j = 0;
  const mix = () => {
    for (let i = 0; i < 4; i++) {
      R[i] =
        (R[i] +
          K[j] +
          (R[(i + 3) & 3] & R[(i + 2) & 3]) +
          (~R[(i + 3) & 3] & R[(i + 1) & 3])) &
        0xffff;
      j++;
      R[i] = ((R[i] << S[i]) | (R[i] >> (16 - S[i]))) & 0xffff;
    }
  };
  const mash = () => {
    for (let i = 0; i < 4; i++) R[i] = (R[i] + K[R[(i + 3) & 3] & 63]) & 0xffff;
  };
  for (let n = 0; n < 5; n++) mix();
  mash();
  for (let n = 0; n < 6; n++) mix();
  mash();
  for (let n = 0; n < 5; n++) mix();
  const out = Buffer.alloc(8);
  R.forEach((r, i) => out.writeUInt16LE(r, i * 2));
  return out;
}

export function rc2DecryptBlock(K: Uint16Array, block: Buffer): Buffer {
  const R = [0, 1, 2, 3].map((i) => block.readUInt16LE(i * 2));
  let j = 63;
  const mix = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = ((R[i] >> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
      R[i] =
        (R[i] -
          K[j] -
          (R[(i + 3) & 3] & R[(i + 2) & 3]) -
          (~R[(i + 3) & 3] & R[(i + 1) & 3])) &
        0xffff;
      j--;
    }
  };
  const mash = () => {
    for (let i = 3; i >= 0; i--)
      R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff;
  };
  for (let n = 0; n < 5; n++) mix();
  mash();
  for (let n = 0; n < 6; n++) mix();
  mash();
  for (let n = 0; n < 5; n++) mix();
  const out = Buffer.alloc(8);
  R.forEach((r, i) => out.writeUInt16LE(r, i * 2));
  return out;
}

/** RC2-CBC decrypt with PKCS#7 padding removal. */
export function rc2CbcDecrypt(
  key: Buffer,
  effectiveBits: number,
  iv: Buffer,
  data: Buffer,
): Buffer {
  if (data.length % 8 !== 0 || data.length === 0)
    throw new Error('RC2: ciphertext is not whole blocks');
  const K = rc2Expand(key, effectiveBits);
  const out = Buffer.alloc(data.length);
  let prev = iv;
  for (let p = 0; p < data.length; p += 8) {
    const block = data.subarray(p, p + 8);
    const plain = rc2DecryptBlock(K, block);
    for (let i = 0; i < 8; i++) out[p + i] = plain[i] ^ prev[i];
    prev = block;
  }
  const pad = out[out.length - 1];
  if (
    pad < 1 ||
    pad > 8 ||
    out.subarray(out.length - pad).some((b) => b !== pad)
  )
    throw new Error('RC2: bad padding (wrong password?)');
  return out.subarray(0, out.length - pad);
}
