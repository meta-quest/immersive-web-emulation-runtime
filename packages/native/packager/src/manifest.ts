/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Rewrite the template's binary AndroidManifest.xml for one app (PKG-8).
 *
 * The template carries everything that does not depend on the app: the
 * launcher activity (`android.app.NativeActivity`, VR intent category,
 * focus-aware flag), the head-tracking feature, the OpenXR permissions and
 * runtime-broker `<queries>`, `com.oculus.supportedDevices`. The packer sets
 * the identity (package, label, version), the debuggable flag, and appends
 * the permissions and features the config implies. Manifest rules come from
 * Meta's public "VR app manifest" documentation and Android's manifest
 * reference.
 */

import { readFileSync } from 'node:fs';
import type { ResolvedNativeTarget } from '../../src/config/types.ts';
import {
  ANDROID_NS,
  AxmlError,
  attrString,
  childElements,
  decodeAxml,
  element,
  findAttr,
  removeAttr,
  setAttr,
  type XmlDocument,
  type XmlElement,
} from './axml.ts';
import { entryData, findEntry, readZip } from './zip.ts';

export const INTERNET_PERMISSION = 'android.permission.INTERNET';
export const HEADTRACKING_FEATURE = 'android.hardware.vr.headtracking';
export const SUPPORTED_DEVICES_KEY = 'com.oculus.supportedDevices';
/**
 * Horizon OS shows `assets/vr_splash.png` as the system splash while the app
 * starts when the application declares this boolean meta-data (Meta's "Add a
 * Splash Screen" documentation).
 */
export const OS_SPLASH_KEY = 'com.oculus.ossplash';
/**
 * What Horizon OS shows behind the system splash during the launch
 * transition (Meta's "Passthrough Loading Screen" documentation): "black" (the
 * default when absent) or "passthrough-contextual" (passthrough if the user's
 * home environment shows passthrough, black otherwise). Read as a string.
 */
export const OS_SPLASH_BACKGROUND_KEY = 'com.oculus.ossplash.background';
export type OsSplashBackground = 'black' | 'passthrough-contextual';

export interface ManifestEdit {
  target: ResolvedNativeTarget;
  /** Debug build: debuggable, INTERNET for the inspector (PKG-8). */
  debuggable: boolean;
  /** The build serves the inspector or debug endpoint (needs INTERNET). */
  servesInspector: boolean;
  /** `com.oculus.supportedDevices` override ("quest3|quest3s"), or null to keep the template's. */
  supportedDevices?: string | null;
  /**
   * The APK carries the system splash image: true declares it
   * (`com.oculus.ossplash`), false removes any declaration, undefined leaves
   * the template's manifest as it is.
   */
  splash?: boolean;
  /**
   * `com.oculus.ossplash.background` (also without a splash image: it is the
   * launch transition's background); null removes it, undefined leaves the
   * template's manifest as it is.
   */
  splashBackground?: OsSplashBackground | null;
}

export interface ManifestSummary {
  packageId: string;
  label: string;
  versionCode: number;
  versionName: string;
  debuggable: boolean;
  permissions: string[];
  features: { name: string; required: boolean }[];
  launcherActivity: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  /** The application declares the system splash (`com.oculus.ossplash` true). */
  osSplash: boolean;
  /** `com.oculus.ossplash.background`, or null when not declared (Horizon OS then uses black). */
  osSplashBackground: string | null;
}

/** Edit the decoded template manifest in place. */
export function applyManifest(doc: XmlDocument, edit: ManifestEdit): void {
  const manifest = doc.root;
  if (manifest.name !== 'manifest')
    throw new AxmlError('root element is not <manifest>');
  if (!doc.namespaces.some((n) => n.uri === ANDROID_NS))
    doc.namespaces.unshift({ prefix: 'android', uri: ANDROID_NS });
  const { target } = edit;

  // Relative class names (".Foo", "Foo") resolve against the package
  // attribute; qualify them with the template's package before renaming it so
  // they keep naming the template's classes.
  const oldPackage = attrString(manifest, 'package', null);
  if (oldPackage) qualifyClassNames(manifest, oldPackage);

  setAttr(
    manifest,
    'package',
    { type: 'string', value: target.packageId },
    null,
  );
  setAttr(manifest, 'versionCode', { type: 'int', value: target.versionCode });
  setAttr(manifest, 'versionName', { type: 'string', value: target.version });

  const application = childElements(manifest, 'application')[0];
  if (!application)
    throw new AxmlError('template manifest has no <application>');
  setAttr(application, 'label', { type: 'string', value: target.appName });
  if (edit.debuggable)
    setAttr(application, 'debuggable', { type: 'bool', value: true });
  else removeAttr(application, 'debuggable');
  for (const activity of [
    ...childElements(application, 'activity'),
    ...childElements(application, 'activity-alias'),
  ]) {
    // A label on the activity (or alias) wins over the application's in the launcher.
    if (findAttr(activity, 'label'))
      setAttr(activity, 'label', { type: 'string', value: target.appName });
  }
  if (edit.supportedDevices) {
    const meta = childElements(application, 'meta-data').find(
      (m) => attrString(m, 'name') === SUPPORTED_DEVICES_KEY,
    );
    if (meta)
      setAttr(meta, 'value', { type: 'string', value: edit.supportedDevices });
    else
      application.children.unshift(
        element('meta-data', {
          name: { type: 'string', value: SUPPORTED_DEVICES_KEY },
          value: { type: 'string', value: edit.supportedDevices },
        }),
      );
  }
  if (edit.splash !== undefined) {
    // A typed boolean, as aapt writes android:value="true": Horizon OS reads it with Bundle.getBoolean, which
    // ignores a string "true".
    application.children = application.children.filter(
      (c) =>
        !(
          c.kind === 'element' &&
          c.name === 'meta-data' &&
          attrString(c, 'name') === OS_SPLASH_KEY
        ),
    );
    if (edit.splash)
      application.children.unshift(
        element('meta-data', {
          name: { type: 'string', value: OS_SPLASH_KEY },
          value: { type: 'bool', value: true },
        }),
      );
  }
  if (edit.splashBackground !== undefined) {
    // A string (Horizon OS reads it with Bundle.getString).
    application.children = application.children.filter(
      (c) =>
        !(
          c.kind === 'element' &&
          c.name === 'meta-data' &&
          attrString(c, 'name') === OS_SPLASH_BACKGROUND_KEY
        ),
    );
    if (edit.splashBackground)
      application.children.unshift(
        element('meta-data', {
          name: { type: 'string', value: OS_SPLASH_BACKGROUND_KEY },
          value: { type: 'string', value: edit.splashBackground },
        }),
      );
  }

  // Permissions: template's + config's (+ INTERNET when sockets are needed).
  // The packer owns the INTERNET rule (PKG-8): a template that ships it has it
  // removed from plain release builds without network access.
  const wanted = new Set(target.permissions);
  const needsInternet =
    target.network.allow.length > 0 ||
    edit.servesInspector ||
    edit.debuggable ||
    wanted.has(INTERNET_PERMISSION);
  if (needsInternet) wanted.add(INTERNET_PERMISSION);
  else
    manifest.children = manifest.children.filter(
      (c) =>
        !(
          c.kind === 'element' &&
          c.name === 'uses-permission' &&
          attrString(c, 'name') === INTERNET_PERMISSION
        ),
    );
  const existing = new Set(
    childElements(manifest, 'uses-permission').map((p) =>
      attrString(p, 'name'),
    ),
  );
  const newPermissions = [...wanted].filter((p) => !existing.has(p)).sort();

  // Features: merge `required` (a feature is required if anyone requires it).
  const featureEls = childElements(manifest, 'uses-feature');
  const newFeatures: XmlElement[] = [];
  for (const f of target.usesFeatures) {
    const el = featureEls.find((e) => attrString(e, 'name') === f.name);
    if (el) {
      const was = findAttr(el, 'required');
      const wasRequired =
        !was || (was.value.type === 'bool' ? was.value.value : true);
      setAttr(el, 'required', {
        type: 'bool',
        value: wasRequired || f.required,
      });
    } else {
      newFeatures.push(
        element('uses-feature', {
          name: { type: 'string', value: f.name },
          required: { type: 'bool', value: f.required },
        }),
      );
    }
  }

  // Insert after the last existing permission/feature (before <application>).
  const insertAt = (() => {
    let last = -1;
    manifest.children.forEach((c, i) => {
      if (
        c.kind === 'element' &&
        (c.name === 'uses-permission' ||
          c.name === 'uses-feature' ||
          c.name === 'uses-sdk')
      )
        last = i;
    });
    if (last >= 0) return last + 1;
    const app = manifest.children.indexOf(application);
    return app >= 0 ? app : manifest.children.length;
  })();
  manifest.children.splice(
    insertAt,
    0,
    ...newPermissions.map((name) =>
      element('uses-permission', { name: { type: 'string', value: name } }),
    ),
    ...newFeatures,
  );
}

const COMPONENT_TAGS = [
  'activity',
  'activity-alias',
  'service',
  'receiver',
  'provider',
];

function qualify(name: string, pkg: string): string {
  if (name.startsWith('.')) return pkg + name;
  if (!name.includes('.')) return `${pkg}.${name}`;
  return name;
}

/** Make component class names absolute (see applyManifest). */
export function qualifyClassNames(manifest: XmlElement, pkg: string): void {
  const fix = (el: XmlElement, attr: string) => {
    const value = attrString(el, attr);
    if (value === undefined) return;
    const q = qualify(value, pkg);
    if (q !== value) setAttr(el, attr, { type: 'string', value: q });
  };
  for (const application of childElements(manifest, 'application')) {
    fix(application, 'name');
    fix(application, 'backupAgent');
    for (const tag of COMPONENT_TAGS)
      for (const el of childElements(application, tag)) {
        fix(el, 'name');
        if (tag === 'activity-alias') fix(el, 'targetActivity');
      }
  }
  for (const el of childElements(manifest, 'instrumentation')) fix(el, 'name');
}

export const VR_CATEGORY = 'com.oculus.intent.category.VR';
export const OPENXR_PERMISSION = 'org.khronos.openxr.permission.OPENXR';

/**
 * Warnings for a template manifest that lacks the immersive-app content the
 * packer relies on the template for (PKG-8, template contract in
 * packager/README.md). The APK still installs, but Horizon OS treats it as
 * a 2D panel app (or the OpenXR loader cannot reach the runtime).
 */
export function templateContractWarnings(doc: XmlDocument): string[] {
  const m = doc.root;
  const warnings: string[] = [];
  const app = childElements(m, 'application')[0];
  const launchers = app
    ? [
        ...childElements(app, 'activity'),
        ...childElements(app, 'activity-alias'),
      ].filter((a) =>
        childElements(a, 'intent-filter').some((f) =>
          childElements(f, 'category').some(
            (c) => attrString(c, 'name') === 'android.intent.category.LAUNCHER',
          ),
        ),
      )
    : [];
  if (launchers.length === 0)
    warnings.push('the template manifest has no launcher activity');
  else if (
    !launchers.some((a) =>
      childElements(a, 'intent-filter').some((f) =>
        childElements(f, 'category').some(
          (c) => attrString(c, 'name') === VR_CATEGORY,
        ),
      ),
    )
  )
    warnings.push(
      `the template's launcher activity has no ${VR_CATEGORY} category: Horizon OS starts the app as a 2D panel`,
    );
  if (
    !childElements(m, 'uses-feature').some(
      (f) => attrString(f, 'name') === HEADTRACKING_FEATURE,
    )
  )
    warnings.push(
      `the template manifest does not declare the ${HEADTRACKING_FEATURE} feature`,
    );
  if (
    !childElements(m, 'uses-permission').some(
      (p) => attrString(p, 'name') === OPENXR_PERMISSION,
    )
  )
    warnings.push(
      `the template manifest lacks the ${OPENXR_PERMISSION} permission (OpenXR loader access)`,
    );
  return warnings;
}

/** The manifest summary of an APK file, or null if it cannot be read. */
export function readApkManifest(file: string): ManifestSummary | null {
  try {
    const zip = readZip(readFileSync(file));
    const entry = findEntry(zip, 'AndroidManifest.xml');
    return entry ? summarizeManifest(decodeAxml(entryData(zip, entry))) : null;
  } catch {
    return null;
  }
}

/** `assets/iwn/config.json` of an APK, or null. */
export function readApkRuntimeConfig(file: string): unknown {
  try {
    const zip = readZip(readFileSync(file));
    const entry = findEntry(zip, 'assets/iwn/config.json');
    return entry ? JSON.parse(entryData(zip, entry).toString('utf8')) : null;
  } catch {
    return null;
  }
}

/** Read back what an installer would see (for reports and tests). */
export function summarizeManifest(doc: XmlDocument): ManifestSummary {
  const m = doc.root;
  const app = childElements(m, 'application')[0];
  const sdk = childElements(m, 'uses-sdk')[0];
  const intAttr = (el: XmlElement | undefined, name: string): number | null => {
    if (!el) return null;
    const a = findAttr(el, name);
    if (!a) return null;
    if (a.value.type === 'int') return a.value.value;
    if (a.value.type === 'typed') return a.value.data;
    if (a.value.type === 'string' && /^\d+$/.test(a.value.value))
      return Number(a.value.value);
    return null;
  };
  let launcher: string | null = null;
  for (const activity of app
    ? [
        ...childElements(app, 'activity'),
        ...childElements(app, 'activity-alias'),
      ]
    : []) {
    const isLauncher = childElements(activity, 'intent-filter').some((f) =>
      childElements(f, 'category').some(
        (c) => attrString(c, 'name') === 'android.intent.category.LAUNCHER',
      ),
    );
    if (isLauncher) {
      launcher = attrString(activity, 'name') ?? null;
      break;
    }
  }
  const dbg = app ? findAttr(app, 'debuggable') : undefined;
  const splashMeta = app
    ? childElements(app, 'meta-data').find(
        (e) => attrString(e, 'name') === OS_SPLASH_KEY,
      )
    : undefined;
  const splashValue = splashMeta ? findAttr(splashMeta, 'value') : undefined;
  const splashBackgroundMeta = app
    ? childElements(app, 'meta-data').find(
        (e) => attrString(e, 'name') === OS_SPLASH_BACKGROUND_KEY,
      )
    : undefined;
  return {
    packageId: attrString(m, 'package', null) ?? '',
    label: (app && attrString(app, 'label')) ?? '',
    versionCode: intAttr(m, 'versionCode') ?? 0,
    versionName: attrString(m, 'versionName') ?? '',
    debuggable: dbg?.value.type === 'bool' ? dbg.value.value : false,
    permissions: childElements(m, 'uses-permission')
      .map((p) => attrString(p, 'name') ?? '')
      .sort(),
    features: childElements(m, 'uses-feature')
      .filter((f) => attrString(f, 'name') !== undefined)
      .map((f) => {
        const r = findAttr(f, 'required');
        return {
          name: attrString(f, 'name') ?? '',
          required: !r || (r.value.type === 'bool' ? r.value.value : true),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    launcherActivity: launcher,
    minSdk: intAttr(sdk, 'minSdkVersion'),
    targetSdk: intAttr(sdk, 'targetSdkVersion'),
    osSplash:
      splashValue?.value.type === 'bool' ? splashValue.value.value : false,
    osSplashBackground: splashBackgroundMeta
      ? (attrString(splashBackgroundMeta, 'value') ?? null)
      : null,
  };
}
