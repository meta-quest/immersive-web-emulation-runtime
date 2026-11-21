/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

declare module 'websql-configurable/custom/index.js' {
  const customOpenDatabase: (driver: unknown, opts?: unknown) => unknown;
  export default customOpenDatabase;
}
declare module 'indexeddbshim/src/setGlobalVars.js' {
  const setGlobalVars: (target: unknown, config?: unknown) => unknown;
  export default setGlobalVars;
}
