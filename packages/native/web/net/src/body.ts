/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fetch §5.1 bodies: "extract a body" from BodyInit, the Body mixin's consumers (arrayBuffer, bytes,
// text, json, blob, formData), `body` as a ReadableStream, bodyUsed, and tee for clone() (NET-9).
//
// A body stays in its cheapest form until someone asks for a stream: known bytes (assets, strings,
// buffers) are handed out without a copy (NET-3: a fetched asset's ArrayBuffer is the native one), a
// network body is a pull source fed by native chunks with flow control, and only `.body` turns either
// into a ReadableStream.

import {
  blobToBytes,
  concatBytes,
  copyBytes,
  domException,
  isBufferSource,
  makeBlob,
  utf8Decode,
  utf8Encode,
  type NetEnv,
} from './env.ts';
import { getReadableStream } from './streams.ts';

/** A pull source of body bytes (network bodies). read() resolves null at the end. */
export interface ByteSource {
  read(): Promise<Uint8Array | null>;
  cancel(reason?: unknown): void;
}

type Content =
  | { kind: 'bytes'; bytes: Uint8Array; shared: boolean }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'source'; source: ByteSource }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array>; tracked?: boolean };

export class InnerBody {
  content: Content;
  /** Total length when known (Content-Length for requests). */
  length: number | null;
  disturbed = false;

  constructor(content: Content, length: number | null) {
    this.content = content;
    this.length = length;
  }

  static fromBytes(bytes: Uint8Array): InnerBody {
    return new InnerBody(
      { kind: 'bytes', bytes, shared: false },
      bytes.byteLength,
    );
  }
  static fromSource(
    source: ByteSource,
    length: number | null = null,
  ): InnerBody {
    return new InnerBody({ kind: 'source', source }, length);
  }

  /**
   * The ReadableStream view (created once). Every exposed stream has highWaterMark 0 and pulls on
   * demand, so the first read (or cancel) marks the body disturbed (bodyUsed) as Fetch requires.
   */
  stream(): ReadableStream<Uint8Array> {
    const c = this.content;
    if (c.kind === 'stream' && c.tracked) return c.stream;
    const stream = this.#build(true);
    this.content = { kind: 'stream', stream, tracked: true };
    return stream;
  }

  #build(track: boolean): ReadableStream<Uint8Array> {
    const c = this.content;
    const RS = getReadableStream();
    const zero = { highWaterMark: 0 };
    const mark = () => {
      if (track) this.disturbed = true;
    };
    let stream: ReadableStream<Uint8Array>;
    if (c.kind === 'bytes') {
      let bytes: Uint8Array | null = c.shared ? c.bytes.slice() : c.bytes;
      stream = new RS<Uint8Array>(
        {
          pull(ctrl) {
            mark();
            if (bytes && bytes.byteLength) ctrl.enqueue(bytes);
            bytes = null;
            ctrl.close();
          },
          cancel() {
            mark();
            bytes = null;
          },
        },
        zero,
      );
    } else if (c.kind === 'blob') {
      const blob = c.blob;
      let done = false;
      stream = new RS<Uint8Array>(
        {
          async pull(ctrl) {
            mark();
            if (!done) {
              done = true;
              const b = new Uint8Array(await blob.arrayBuffer());
              if (b.byteLength) ctrl.enqueue(b);
            }
            ctrl.close();
          },
          cancel() {
            mark();
          },
        },
        zero,
      );
    } else if (c.kind === 'source') {
      const source = c.source;
      stream = new RS<Uint8Array>(
        {
          async pull(ctrl) {
            mark();
            const chunk = await source.read();
            if (chunk === null) ctrl.close();
            else ctrl.enqueue(chunk);
          },
          cancel(reason) {
            mark();
            source.cancel(reason);
          },
        },
        zero,
      );
    } else {
      const reader = c.stream.getReader();
      stream = new RS<Uint8Array>(
        {
          async pull(ctrl) {
            mark();
            const { done, value } = await reader.read();
            if (done) ctrl.close();
            else ctrl.enqueue(value);
          },
          cancel(reason) {
            mark();
            return reader.cancel(reason);
          },
        },
        zero,
      );
    }
    return stream;
  }

  locked(): boolean {
    // An untracked stream is internal (a tee branch or a stream handed to the constructor), so it
    // counts as locked only if page code locked it.
    return this.content.kind === 'stream' && this.content.stream.locked;
  }

  unusable(): boolean {
    return this.disturbed || this.locked();
  }

  /** Reads everything (marks the body disturbed). */
  async consume(env: NetEnv | null): Promise<Uint8Array> {
    if (this.unusable())
      throw new TypeError('Body is unusable: body has already been read');
    this.disturbed = true;
    const c = this.content;
    switch (c.kind) {
      case 'bytes':
        return c.shared ? c.bytes.slice() : c.bytes;
      case 'blob':
        return env
          ? (await blobToBytes(env, c.blob)).slice()
          : new Uint8Array(await c.blob.arrayBuffer());
      case 'source': {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const chunk = await c.source.read();
          if (chunk === null) break;
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        return concatBytes(chunks, total);
      }
      case 'stream': {
        const reader = c.stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array))
            throw new TypeError('Body stream chunk is not a Uint8Array');
          chunks.push(value);
          total += value.byteLength;
        }
        return concatBytes(chunks, total);
      }
    }
  }

  /** Fetch "clone a body": tee. Returns the second branch; this body keeps the first. */
  tee(): InnerBody {
    const c = this.content;
    if (c.kind === 'bytes') {
      c.shared = true;
      return new InnerBody(
        { kind: 'bytes', bytes: c.bytes, shared: true },
        this.length,
      );
    }
    if (c.kind === 'blob')
      return new InnerBody({ kind: 'blob', blob: c.blob }, this.length);
    // Tee the untracked form: reading a branch must not mark the other one used.
    const c2 = this.content;
    const raw =
      c2.kind === 'stream' && !c2.tracked ? c2.stream : this.#build(false);
    const [a, b] = raw.tee();
    this.content = { kind: 'stream', stream: a, tracked: false };
    return new InnerBody(
      { kind: 'stream', stream: b, tracked: false },
      this.length,
    );
  }
}

export interface Extracted {
  body: InnerBody;
  type: string | null;
}

/** Fetch "extract a body" (keepalive aside). */
export function extractBody(init: unknown, env: NetEnv | null): Extracted {
  if (typeof init === 'string') {
    return {
      body: InnerBody.fromBytes(utf8Encode(init)),
      type: 'text/plain;charset=UTF-8',
    };
  }
  if (isBufferSource(init))
    return { body: InnerBody.fromBytes(copyBytes(init)), type: null };
  const BlobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
  if (BlobCtor && init instanceof BlobCtor) {
    return {
      body: new InnerBody({ kind: 'blob', blob: init }, init.size),
      type: init.type || null,
    };
  }
  const USP = (globalThis as { URLSearchParams?: typeof URLSearchParams })
    .URLSearchParams;
  if (USP && init instanceof USP) {
    return {
      body: InnerBody.fromBytes(utf8Encode(init.toString())),
      type: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  const FD = (globalThis as { FormData?: typeof FormData }).FormData;
  if (FD && init instanceof FD) return extractFormData(init, env);
  const RS = (globalThis as { ReadableStream?: typeof ReadableStream })
    .ReadableStream;
  if ((RS && init instanceof RS) || isStreamLike(init)) {
    const s = init as ReadableStream<Uint8Array>;
    if (s.locked) throw new TypeError('ReadableStream is locked');
    return {
      body: new InnerBody({ kind: 'stream', stream: s }, null),
      type: null,
    };
  }
  return {
    body: InnerBody.fromBytes(utf8Encode(String(init))),
    type: 'text/plain;charset=UTF-8',
  };
}

function isStreamLike(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ReadableStream).getReader === 'function' &&
    typeof (v as ReadableStream).tee === 'function'
  );
}

function extractFormData(fd: FormData, env: NetEnv | null): Extracted {
  const rnd = new Uint8Array(12);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(rnd);
  else
    for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 73 + Date.now()) & 0xff;
  const boundary =
    '----iwnFormBoundary' +
    Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  const escape = (s: string) =>
    s
      .replace(/\r\n|\r|\n/g, '\r\n')
      .replace(/"/g, '%22')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
  const entries = [...fd.entries()];
  let done = false;
  const source: ByteSource = {
    async read() {
      if (done) return null;
      done = true;
      const parts: Uint8Array[] = [];
      for (const [name, value] of entries) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"`;
        if (typeof value === 'string') {
          parts.push(
            utf8Encode(
              head + '\r\n\r\n' + value.replace(/\r\n|\r|\n/g, '\r\n') + '\r\n',
            ),
          );
        } else {
          const file = value as File;
          head += `; filename="${escape(file.name ?? 'blob')}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
          parts.push(utf8Encode(head));
          parts.push(
            env
              ? await blobToBytes(env, file)
              : new Uint8Array(await file.arrayBuffer()),
          );
          parts.push(utf8Encode('\r\n'));
        }
      }
      parts.push(utf8Encode(`--${boundary}--\r\n`));
      return concatBytes(parts);
    },
    cancel() {
      done = true;
    },
  };
  return {
    body: InnerBody.fromSource(source),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

/** MIME type essence of a Content-Type value ("" when unparsable), for Blob types. */
export function mimeEssence(contentType: string | null): string {
  if (!contentType) return '';
  const essence = contentType.split(';')[0].trim().toLowerCase();
  return /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(essence)
    ? contentType
        .trim()
        .toLowerCase()
        .replace(/\s*;\s*/g, ';')
    : '';
}

/** The Body mixin, shared by Request and Response. */
export interface BodyOwner {
  innerBody(): InnerBody | null;
  contentType(): string | null;
  env(): NetEnv | null;
}

export async function consumeArrayBuffer(o: BodyOwner): Promise<ArrayBuffer> {
  const bytes = await consumeBytes(o);
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export async function consumeBytes(
  o: BodyOwner,
): Promise<Uint8Array<ArrayBuffer>> {
  const b = o.innerBody();
  if (!b) return new Uint8Array(0);
  return (await b.consume(o.env())) as Uint8Array<ArrayBuffer>;
}

export async function consumeText(o: BodyOwner): Promise<string> {
  return utf8Decode(await consumeBytes(o));
}

export async function consumeJson(o: BodyOwner): Promise<unknown> {
  return JSON.parse(await consumeText(o));
}

export async function consumeBlob(o: BodyOwner): Promise<Blob> {
  const bytes = await consumeBytes(o);
  const type = mimeEssence(o.contentType());
  const env = o.env();
  return env ? makeBlob(env, bytes, type) : new Blob([bytes], { type });
}

export async function consumeFormData(o: BodyOwner): Promise<FormData> {
  const FD = (globalThis as { FormData?: typeof FormData }).FormData;
  const type = mimeEssence(o.contentType()).split(';')[0];
  if (!FD) {
    await consumeBytes(o);
    throw domException(
      'formData() is not supported by this runtime',
      'NotSupportedError',
    );
  }
  if (type === 'application/x-www-form-urlencoded') {
    const text = await consumeText(o);
    const fd = new FD();
    for (const [k, v] of new URLSearchParams(text)) fd.append(k, v);
    return fd;
  }
  await consumeBytes(o);
  if (type === 'multipart/form-data')
    throw domException(
      'multipart formData() parsing is not supported',
      'NotSupportedError',
    );
  throw new TypeError('Could not parse content as FormData');
}
