/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `navigator` basics (HTML §8.9.1 NavigatorID/Language/OnLine/Concurrency, Device Memory, Permissions,
// Storage) for DOM-4. `xr` (IWER), `getGamepads` (input) and, for an app that declares the camera,
// `mediaDevices` (web/xr camera.ts, XR-CAM-1) are installed by their owners on the same object. Members a
// browser has but this runtime does not (userAgentData, gpu, serviceWorker, clipboard, wakeLock, share,
// mediaCapabilities, and mediaDevices without the camera) are deliberately absent so feature detection
// takes its fallback path.

import type { DeviceInfo, GlueConfig } from './natives.ts';
import { defineEventHandler, EventTarget } from './events.ts';
import { enumerable, illegalConstructor, INTERNAL, tag, toDOMString } from './util.ts';

export const RUNTIME_TOKEN = 'IWERNative';

/**
 * Quest Browser version tokens used by the `quest-browser` policy. Placeholders until measured on the
 * same headset/OS build (spec convention "As Quest Browser"); override through config.
 */
export const QUEST_BROWSER_TOKENS = {
  oculusBrowser: '40.0.0.0',
  chrome: '138.0.0.0',
};

/**
 * The user agent string (DOM-4, open question 2).
 *
 * `honest` (default): `Mozilla/5.0 (Linux; Android <rel>; <model>) AppleWebKit/537.36 (KHTML, like Gecko)
 * VR Safari/537.36 IWERNative/<version>`. It contains `Android` (spec), the runtime name and version, and
 * the WebKit/Safari compatibility tokens every mobile Chromium UA has. "Android" also keeps three.js's
 * Safari sniff (`/^((?!chrome|android).)*safari/i` in GLTFLoader/ImageBitmapLoader) from misfiring.
 * No `Chrome/` or `OculusBrowser/` token: code that branches on those would assume Chromium features
 * (DOM layout, WebGPU, media) that this runtime does not have.
 *
 * `quest-browser`: inserts `OculusBrowser/<v> Chrome/<v>` before `VR Safari`, for apps that gate WebXR
 * paths on Quest Browser sniffing. IWSDK's injected emulator also stands down on `OculusBrowser`, but
 * native builds turn injection off anyway (GAP-7), so the honest default does not need it.
 */
export function buildUserAgent(config: GlueConfig, info: DeviceInfo): string {
  const policy = config.userAgent ?? 'honest';
  if (typeof policy === 'object' && policy && typeof policy.literal === 'string') {
    return policy.literal;
  }
  const rel = info.androidRelease ?? '14';
  const model = info.model ?? 'Quest';
  const version = config.runtimeVersion ?? '0.0.0';
  const head = `Mozilla/5.0 (Linux; Android ${rel}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko)`;
  const tail = `VR Safari/537.36 ${RUNTIME_TOKEN}/${version}`;
  if (policy === 'quest-browser') {
    return `${head} OculusBrowser/${QUEST_BROWSER_TOKENS.oculusBrowser} Chrome/${QUEST_BROWSER_TOKENS.chrome} ${tail}`;
  }
  return `${head} ${tail}`;
}

function deviceMemoryOf(gib: number | undefined): number | undefined {
  if (gib === undefined || !(gib > 0)) return undefined;
  // Device Memory §2 (and Chrome): round to the nearest power of two, clamp to [0.25, 8]. A Quest 3
  // reporting ~7.5 GiB gets 8, as in Quest Browser.
  // "Nearest" in GiB, ties to the lower power (e.g. 6 GiB -> 4).
  const lower = 2 ** Math.floor(Math.log2(gib));
  const p = gib - lower <= lower * 2 - gib ? lower : lower * 2;
  return Math.min(8, Math.max(0.25, p));
}

let permissionInit!: (s: PermissionStatus, name: string, state: string) => void;
export class PermissionStatus extends EventTarget {
  #name = '';
  #state = 'prompt';
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
    super();
  }
  static {
    permissionInit = (s, name, state) => {
      s.#name = name;
      s.#state = state;
    };
  }
  get name(): string {
    return this.#name;
  }
  get state(): string {
    return this.#state;
  }
}
tag(PermissionStatus, 'PermissionStatus');
enumerable(PermissionStatus, ['name', 'state']);
defineEventHandler(PermissionStatus.prototype, 'change');

// PermissionName values (Permissions spec registry plus the names Chromium's enum accepts). Others
// are not a valid enum value, so query() rejects with TypeError, as in browsers.
const PERMISSION_NAMES = new Set([
  'accelerometer',
  'ambient-light-sensor',
  'background-fetch',
  'background-sync',
  'bluetooth',
  'camera',
  'captured-surface-control',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'idle-detection',
  'keyboard-lock',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'nfc',
  'notifications',
  'payment-handler',
  'periodic-background-sync',
  'persistent-storage',
  'pointer-lock',
  'push',
  'screen-wake-lock',
  'speaker-selection',
  'storage-access',
  'system-wake-lock',
  'top-level-storage-access',
  'web-app-installation',
  'window-management',
  'xr-spatial-tracking',
]);

export class Permissions {
  #granted: () => ReadonlySet<string>;
  constructor(token?: unknown, granted?: () => ReadonlySet<string>) {
    if (token !== INTERNAL) throw illegalConstructor();
    this.#granted = granted ?? (() => new Set());
  }
  query(descriptor: { name: string }): Promise<PermissionStatus> {
    if (!(this instanceof Permissions)) return Promise.reject(new TypeError('Illegal invocation'));
    if (descriptor == null || typeof descriptor !== 'object' || descriptor.name === undefined) {
      return Promise.reject(
        new TypeError(
          "Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined.",
        ),
      );
    }
    let name: string;
    try {
      name = toDOMString(descriptor.name, "Failed to execute 'query' on 'Permissions'");
    } catch (e) {
      return Promise.reject(e);
    }
    if (!PERMISSION_NAMES.has(name)) {
      return Promise.reject(
        new TypeError(
          `Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value '${name}' is not a valid enum value of type PermissionName.`,
        ),
      );
    }
    const s = new PermissionStatus(INTERNAL);
    permissionInit(s, name, this.#granted().has(name) ? 'granted' : 'prompt');
    return Promise.resolve(s);
  }
}
tag(Permissions, 'Permissions');
enumerable(Permissions, ['query']);

export class StorageManager {
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
  }
  estimate(): Promise<{ quota: number; usage: number }> {
    // localStorage's 5 MB quota is the only storage this runtime offers (NET-STORE-1/3).
    return Promise.resolve({ quota: 5 * 1024 * 1024, usage: 0 });
  }
}
tag(StorageManager, 'StorageManager');
enumerable(StorageManager, ['estimate']);

let navState!: (n: Navigator) => NavState;
interface NavState {
  ua: string;
  info: () => DeviceInfo;
  permissions: Permissions;
  storage: StorageManager;
  languages: readonly string[];
}

export class Navigator {
  #s: NavState;
  constructor(token?: unknown, state?: NavState) {
    if (token !== INTERNAL) throw illegalConstructor();
    this.#s = state!;
  }
  static {
    navState = (n) => n.#s;
  }
  get userAgent(): string {
    return this.#s.ua;
  }
  get appVersion(): string {
    return this.#s.ua.replace(/^Mozilla\//, '');
  }
  get appName(): string {
    return 'Netscape';
  }
  get appCodeName(): string {
    return 'Mozilla';
  }
  get product(): string {
    return 'Gecko';
  }
  get productSub(): string {
    return '20030107';
  }
  get platform(): string {
    return 'Linux armv8l';
  }
  get vendor(): string {
    return '';
  }
  get vendorSub(): string {
    return '';
  }
  get language(): string {
    return this.#s.languages[0] ?? 'en-US';
  }
  get languages(): readonly string[] {
    return this.#s.languages;
  }
  get onLine(): boolean {
    return this.#s.info().onLine ?? true;
  }
  get hardwareConcurrency(): number {
    return this.#s.info().hardwareConcurrency ?? 4;
  }
  get maxTouchPoints(): number {
    return 0;
  }
  get cookieEnabled(): boolean {
    return false;
  }
  get pdfViewerEnabled(): boolean {
    return false;
  }
  get webdriver(): boolean {
    return false;
  }
  get doNotTrack(): null {
    return null;
  }
  get permissions(): Permissions {
    return this.#s.permissions;
  }
  get storage(): StorageManager {
    return this.#s.storage;
  }
  javaEnabled(): boolean {
    return false;
  }
  vibrate(): boolean {
    return false;
  }
  sendBeacon(): boolean {
    return false;
  }
}
tag(Navigator, 'Navigator');
enumerable(Navigator, [
  'userAgent',
  'appVersion',
  'appName',
  'appCodeName',
  'product',
  'productSub',
  'platform',
  'vendor',
  'vendorSub',
  'language',
  'languages',
  'onLine',
  'hardwareConcurrency',
  'maxTouchPoints',
  'cookieEnabled',
  'pdfViewerEnabled',
  'webdriver',
  'doNotTrack',
  'permissions',
  'storage',
  'javaEnabled',
  'vibrate',
  'sendBeacon',
]);
Object.defineProperty(Navigator.prototype, 'deviceMemory', {
  get(this: Navigator) {
    return deviceMemoryOf(navState(this).info().deviceMemory) ?? 4;
  },
  enumerable: true,
  configurable: true,
});

/**
 * WorkerNavigator (HTML §8.9.1, WRK-2): the members exposed to workers (NavigatorID, NavigatorLanguage,
 * NavigatorOnLine, NavigatorConcurrentHardware, deviceMemory, permissions, storage). It reuses
 * Navigator's state; its prototype does not inherit Navigator.prototype, so window-only members
 * (vendor, javaEnabled, sendBeacon, ...) are absent, as in browsers.
 */
export class WorkerNavigator extends Navigator {}
for (const name of [
  'userAgent',
  'appVersion',
  'appName',
  'appCodeName',
  'product',
  'platform',
  'language',
  'languages',
  'onLine',
  'hardwareConcurrency',
  'deviceMemory',
  'permissions',
  'storage',
]) {
  Object.defineProperty(WorkerNavigator.prototype, name, Object.getOwnPropertyDescriptor(Navigator.prototype, name)!);
}
Object.setPrototypeOf(WorkerNavigator.prototype, Object.prototype);
tag(WorkerNavigator, 'WorkerNavigator');

/** Permissions an app of this runtime holds without a prompt when the config does not list them. */
export const DEFAULT_GRANTED_PERMISSIONS: readonly string[] = ['xr-spatial-tracking'];

export function createNavigator(
  config: GlueConfig,
  info: () => DeviceInfo,
  worker = false,
  runtimeGrants: () => readonly string[] = () => [],
): Navigator {
  const first = info();
  // DOM-4: `granted` for features the app already has: the packaged ones (config.permissions.granted,
  // default DEFAULT_GRANTED_PERMISSIONS) plus Android runtime grants the host reports in device.info() or a
  // runtime prelude reports for its own feature (GlueRegistry.addPermissionSource).
  const configured = new Set(
    Array.isArray(config.permissions?.granted) ? config.permissions.granted.map(String) : DEFAULT_GRANTED_PERMISSIONS,
  );
  const granted = (): ReadonlySet<string> => {
    const reported = info().grantedPermissions;
    const extra = [...(Array.isArray(reported) ? reported : []), ...runtimeGrants()];
    if (extra.length === 0) return configured;
    const all = new Set(configured);
    for (const p of extra) all.add(String(p));
    return all;
  };
  const langs = first.languages?.length ? first.languages.slice() : ['en-US'];
  return new (worker ? WorkerNavigator : Navigator)(INTERNAL, {
    ua: buildUserAgent(config, first),
    info,
    permissions: new Permissions(INTERNAL, granted),
    storage: new StorageManager(INTERNAL),
    languages: Object.freeze(langs),
  });
}
