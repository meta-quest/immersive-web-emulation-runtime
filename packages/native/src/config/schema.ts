/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  FOVEATION_LEVELS,
  FRAME_RATES,
  NATIVE_FEATURE_NAMES,
  SPLASH_BACKGROUND_NAMES,
} from './types.ts';
import { MAX_VERSION_CODE } from './validate.ts';

const featureFlag = {
  description:
    'true/"optional": use when present; "required": device must have it; false: off.',
  oneOf: [
    { type: 'boolean' },
    { enum: ['required', 'optional'] },
    {
      type: 'object',
      additionalProperties: false,
      properties: { required: { type: 'boolean' } },
    },
  ],
} as const;

/**
 * JSON Schema (2020-12) for the native section, for editor completion. The
 * validator in validate.ts is the authority: it also checks things a schema
 * cannot express well (Java keywords, origins, secrets) and words the errors.
 */
export const NATIVE_TARGET_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'iwsdk.config.json native target',
  type: 'object',
  additionalProperties: false,
  required: ['packageId'],
  properties: {
    packageId: {
      type: 'string',
      description: 'Android application id, e.g. com.yourcompany.yourapp',
      pattern: '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$',
    },
    appName: {
      type: 'string',
      minLength: 1,
      description: 'Launcher label. Default: package.json name.',
    },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'versionName. Default: package.json version.',
    },
    versionCode: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_VERSION_CODE,
      description: 'Default: major*1000000 + minor*1000 + patch of version.',
    },
    icon: {
      type: 'string',
      pattern: '\\.(png|webp|PNG|WEBP)$',
      description: 'Project-relative launcher icon.',
    },
    splash: {
      description:
        'Launch splash (Horizon OS system splash) and loading screen until the first XR frame. Default: on, generated from the icon and appName, on black (contextual for apps that declare passthrough). false: no image or spinner (the background stays).',
      oneOf: [
        { type: 'boolean' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            image: {
              type: 'string',
              pattern: '\\.(png|PNG)$',
              description:
                'Project-relative PNG to show instead of the generated icon + name card.',
            },
            background: {
              description:
                'Behind the splash image. "black" (default without passthrough): always black. "contextual" (default with features.passthrough or world.xr.mode "ar", which it needs): the user\'s room for a user whose home is passthrough, black otherwise (system splash: com.oculus.ossplash.background passthrough-contextual; loading screen: the runtime\'s passthrough layer). "#rrggbb": that colour on the loading screen (the system splash stays black).',
              oneOf: [
                { enum: [...SPLASH_BACKGROUND_NAMES] },
                {
                  type: 'string',
                  pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$',
                },
              ],
            },
          },
        },
      ],
    },
    frameRate: {
      enum: [...FRAME_RATES],
      description: 'Preferred display refresh rate (Hz).',
    },
    foveation: {
      oneOf: [
        { enum: [...FOVEATION_LEVELS] },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { enum: [...FOVEATION_LEVELS] },
            dynamic: { type: 'boolean' },
          },
        },
      ],
    },
    features: {
      type: 'object',
      additionalProperties: false,
      description:
        'Default: derived from world.xr.features (and passthrough for AR, camera for world.features.camera). camera: getUserMedia over the passthrough cameras (permissions android.permission.CAMERA and horizonos.permission.HEADSET_CAMERA).',
      properties: Object.fromEntries(
        NATIVE_FEATURE_NAMES.map((n) => [n, featureFlag]),
      ),
    },
    permissions: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+$',
      },
      uniqueItems: true,
    },
    network: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allow: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Origin: https://host[:port] or https://*.host',
          },
        },
      },
    },
    signing: {
      type: 'object',
      additionalProperties: false,
      required: ['keystore', 'storePasswordEnv'],
      description:
        'Release signing. Secrets are read from the named environment variables, never stored here.',
      properties: {
        keystore: { type: 'string', minLength: 1 },
        keyAlias: { type: 'string', minLength: 1 },
        storePasswordEnv: {
          type: 'string',
          pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
        },
        keyPasswordEnv: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      },
    },
  },
} as const;
