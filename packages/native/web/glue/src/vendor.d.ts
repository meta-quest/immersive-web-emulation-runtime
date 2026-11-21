/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// whatwg-url's webidl2js wrappers: `install(globalObject, globalNames)` defines the interface on it.
declare module 'whatwg-url/webidl2js-wrapper.js' {
  interface Wrapper {
    install(globalObject: Record<string, unknown>, globalNames: string[]): void;
  }
  const wrapper: { URL: Wrapper; URLSearchParams: Wrapper };
  export default wrapper;
}
declare module 'punycode/punycode.es6.js' {
  const punycode: { encode(input: string): string; decode(input: string): string };
  export default punycode;
}
