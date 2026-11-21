/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** The Node packer/signer for @iwer/native. */

export {
  pack,
  formatPackReport,
  formatBytes,
  resolveIdentity,
  PackError,
  type PackInput,
  type PackResult,
} from './pack.ts';
export {
  resolveTemplate,
  openTemplate,
  fetchPinnedTemplate,
  userCacheDir,
  TemplateError,
  type LoadedTemplate,
  type TemplateMetadata,
} from './template.ts';
export {
  signApk,
  verifyApk,
  findSigningBlock,
  ApkSignatureError,
  type VerifyResult,
} from './apk-sign.ts';
export {
  loadKeystoreFile,
  loadKeystoreIdentity,
  KeystoreError,
} from './keystore.ts';
export {
  loadOrCreateDebugIdentity,
  selfSignedCertificate,
  userConfigDir,
  type SigningIdentity,
} from './signing-key.ts';
export { decodeAxml, encodeAxml, axmlToText } from './axml.ts';
export {
  applyManifest,
  summarizeManifest,
  type ManifestSummary,
} from './manifest.ts';
export {
  readZip,
  writeZip,
  checkAlignment,
  entryData,
  findEntry,
} from './zip.ts';
export { listDist, scanIndexHtml, detectInjection, DistError } from './dist.ts';
export { buildRuntimeConfig } from './runtime-config.ts';
