/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// DOMException (WebIDL §3.14.1, DOM-10): every error name with its legacy code, the legacy code
// constants, `name`/`message`/`code` as prototype accessors, Error.prototype in the chain and a V8
// stack trace. Written here (≈1.5 KB) instead of core-js's (≈21 KB minified with its runtime).

import { setLength, tag, toDOMString } from './util.ts';

/** WebIDL "error names" table: name → legacy code (0 when the name has none). */
const NAMES: Record<string, number> = {
  IndexSizeError: 1,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

const CONSTANTS: [string, number][] = [
  ['INDEX_SIZE_ERR', 1],
  ['DOMSTRING_SIZE_ERR', 2],
  ['HIERARCHY_REQUEST_ERR', 3],
  ['WRONG_DOCUMENT_ERR', 4],
  ['INVALID_CHARACTER_ERR', 5],
  ['NO_DATA_ALLOWED_ERR', 6],
  ['NO_MODIFICATION_ALLOWED_ERR', 7],
  ['NOT_FOUND_ERR', 8],
  ['NOT_SUPPORTED_ERR', 9],
  ['INUSE_ATTRIBUTE_ERR', 10],
  ['INVALID_STATE_ERR', 11],
  ['SYNTAX_ERR', 12],
  ['INVALID_MODIFICATION_ERR', 13],
  ['NAMESPACE_ERR', 14],
  ['INVALID_ACCESS_ERR', 15],
  ['VALIDATION_ERR', 16],
  ['TYPE_MISMATCH_ERR', 17],
  ['SECURITY_ERR', 18],
  ['NETWORK_ERR', 19],
  ['ABORT_ERR', 20],
  ['URL_MISMATCH_ERR', 21],
  ['QUOTA_EXCEEDED_ERR', 22],
  ['TIMEOUT_ERR', 23],
  ['INVALID_NODE_TYPE_ERR', 24],
  ['DATA_CLONE_ERR', 25],
];

export class DOMException extends Error {
  #name: string;
  #message: string;
  // WebIDL: constructor(optional DOMString message = "", optional DOMString name = "Error"). Node also
  // takes a `{ name, cause }` options object; browsers stringify it, and so does this class.
  constructor(message?: string, name?: string) {
    const m =
      message === undefined
        ? ''
        : toDOMString(message, "Failed to construct 'DOMException'");
    const n =
      name === undefined
        ? 'Error'
        : toDOMString(name, "Failed to construct 'DOMException'");
    // V8 15.5 writes the stack header ("NotSupportedError: <message>") from the message passed to Error's
    // constructor, not from the `message` accessor, so pass it: e.stack and the runtime's uncaught-error log keep the
    // explanation. Then drop the own data property Error() adds; WebIDL has `message` on the prototype only.
    super(m);
    delete (this as { message?: string }).message;
    this.#message = m;
    this.#name = n;
  }
  // An accessor over Error's data property, as WebIDL specifies.
  override get name(): string {
    return this.#name;
  }
  // An accessor over Error's data property, as WebIDL specifies.
  override get message(): string {
    return this.#message;
  }
  get code(): number {
    return NAMES[this.#name] ?? 0;
  }
}
for (const [k, v] of CONSTANTS) {
  Object.defineProperty(DOMException, k, { value: v, enumerable: true });
  Object.defineProperty(DOMException.prototype, k, {
    value: v,
    enumerable: true,
  });
}
for (const k of ['name', 'message', 'code']) {
  const d = Object.getOwnPropertyDescriptor(DOMException.prototype, k)!;
  d.enumerable = true;
  Object.defineProperty(DOMException.prototype, k, d);
}
tag(DOMException, 'DOMException');
setLength(DOMException, 0);

export function domException(message: string, name: string): DOMException {
  return new DOMException(message, name);
}
