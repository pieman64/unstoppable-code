import { MAX_MESSAGE_BYTES } from '@canopy/protocol/remote-control';
import type { Bytes } from './bytes';

/**
 * A pure-TypeScript reader and writer for the V8 value serialization format
 * that Node's `v8.serialize` / `v8.deserialize` (its `DefaultSerializer`)
 * use, so a browser or Node controller exchanges exactly the values a desktop
 * session carries: primitives, one- and two-byte strings, objects, dense and
 * sparse arrays, references and cycles, Date, RegExp, primitive wrappers,
 * BigInt, ArrayBuffer, Map, Set, Error and typed views.
 *
 * Writes format version 15 (Node 22/24). Reads versions 13 to 16; Electron 45
 * writes 16, which is byte-identical to 15 for every tag handled here.
 *
 * Typed arrays and DataViews travel as Node host objects
 * (`[\\][type index][byte length][bytes]`), only the view's own bytes, as
 * Node's `DefaultSerializer` writes them. Index 10 is Node's `Buffer`; it
 * reads back as a `Uint8Array`. The writer refuses anything V8 would refuse
 * (functions, symbols, promises, weak collections, shared memory) and any
 * object it cannot classify, instead of coercing it.
 */
export const V8_SERIALIZATION_VERSION = 15;
export const V8_MIN_READ_VERSION = 13;
export const V8_MAX_READ_VERSION = 16;
export const V8_DEFAULT_MAX_DEPTH = 1_024;

export type V8SerializationErrorCode =
  | 'unsupported_value'
  | 'too_large'
  | 'too_deep'
  | 'malformed'
  | 'unsupported_version'
  | 'unsupported_tag';

export class V8SerializationError extends Error {
  constructor(
    readonly code: V8SerializationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'V8SerializationError';
  }
}

const TAG = {
  version: 0xff,
  padding: 0x00,
  verifyObjectCount: 0x3f, // ?
  theHole: 0x2d, // -
  undefined: 0x5f, // _
  null: 0x30, // 0
  true: 0x54, // T
  false: 0x46, // F
  int32: 0x49, // I
  uint32: 0x55, // U
  double: 0x4e, // N
  bigint: 0x5a, // Z
  utf8String: 0x53, // S
  oneByteString: 0x22, // "
  twoByteString: 0x63, // c
  objectReference: 0x5e, // ^
  beginJSObject: 0x6f, // o
  endJSObject: 0x7b, // {
  beginSparseJSArray: 0x61, // a
  endSparseJSArray: 0x40, // @
  beginDenseJSArray: 0x41, // A
  endDenseJSArray: 0x24, // $
  date: 0x44, // D
  trueObject: 0x79, // y
  falseObject: 0x78, // x
  numberObject: 0x6e, // n
  bigintObject: 0x7a, // z
  stringObject: 0x73, // s
  regExp: 0x52, // R
  beginJSMap: 0x3b, // ;
  endJSMap: 0x3a, // :
  beginJSSet: 0x27, // '
  endJSSet: 0x2c, // ,
  arrayBuffer: 0x42, // B
  resizableArrayBuffer: 0x7e, // ~
  arrayBufferView: 0x56, // V
  hostObject: 0x5c, // \
  error: 0x72, // r
} as const;

const ERROR_TAG = {
  evalError: 0x45, // E
  rangeError: 0x52, // R
  referenceError: 0x46, // F
  syntaxError: 0x53, // S
  typeError: 0x54, // T
  uriError: 0x55, // U
  message: 0x6d, // m
  cause: 0x63, // c
  stack: 0x73, // s
  end: 0x2e, // .
} as const;

const ERROR_PROTOTYPE_TAGS: ReadonlyMap<string, number> = new Map([
  ['EvalError', ERROR_TAG.evalError],
  ['RangeError', ERROR_TAG.rangeError],
  ['ReferenceError', ERROR_TAG.referenceError],
  ['SyntaxError', ERROR_TAG.syntaxError],
  ['TypeError', ERROR_TAG.typeError],
  ['URIError', ERROR_TAG.uriError],
]);

type ErrorConstructorLike = new (message?: string) => Error;

const ERROR_CONSTRUCTORS: ReadonlyMap<number, ErrorConstructorLike> = new Map<
  number,
  ErrorConstructorLike
>([
  [ERROR_TAG.evalError, EvalError],
  [ERROR_TAG.rangeError, RangeError],
  [ERROR_TAG.referenceError, ReferenceError],
  [ERROR_TAG.syntaxError, SyntaxError],
  [ERROR_TAG.typeError, TypeError],
  [ERROR_TAG.uriError, URIError],
]);

const REGEXP_FLAGS: ReadonlyArray<readonly [string, number]> = [
  ['g', 1],
  ['i', 2],
  ['m', 4],
  ['y', 8],
  ['u', 16],
  ['s', 32],
  ['d', 128],
  ['v', 256],
];
/** V8's non-standard linear-time flag; no portable runtime can build it. */
const REGEXP_LINEAR_FLAG = 64;
const REGEXP_KNOWN_FLAGS = 511;

interface ViewKind {
  readonly bytesPerElement: number;
  create(
    buffer: ArrayBuffer,
    byteOffset: number,
    byteLength: number | null,
  ): unknown;
}

function viewKind(
  bytesPerElement: number,
  create: (buffer: ArrayBuffer, byteOffset: number, length?: number) => unknown,
): ViewKind {
  return {
    bytesPerElement,
    create: (buffer, byteOffset, byteLength) =>
      byteLength === null
        ? create(buffer, byteOffset)
        : create(buffer, byteOffset, byteLength / bytesPerElement),
  };
}

function float16Kind(): ViewKind | null {
  const constructor: unknown = Reflect.get(globalThis, 'Float16Array');
  if (typeof constructor !== 'function') return null;
  return viewKind(2, (buffer, byteOffset, length) => {
    const view: unknown = Reflect.construct(
      constructor,
      length === undefined
        ? [buffer, byteOffset]
        : [buffer, byteOffset, length],
    );
    return view;
  });
}

const UINT8_KIND = viewKind(1, (b, o, l) => new Uint8Array(b, o, l));
const DATA_VIEW_KIND: ViewKind = {
  bytesPerElement: 1,
  create: (buffer, byteOffset, byteLength) =>
    byteLength === null
      ? new DataView(buffer, byteOffset)
      : new DataView(buffer, byteOffset, byteLength),
};

/** Node's host-object type indices (`lib/v8.js`); 10 is `Buffer`. */
const HOST_VIEW_NAMES = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'DataView',
  'Buffer',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
] as const;
/** Writable names by index; `Buffer` (10) is never a `toStringTag`. */
const WRITABLE_HOST_VIEW_NAMES: ReadonlyArray<string> = HOST_VIEW_NAMES.map(
  (name) => (name === 'Buffer' ? '' : name),
);

const VIEW_KINDS: Readonly<Record<string, ViewKind | null>> = {
  Int8Array: viewKind(1, (b, o, l) => new Int8Array(b, o, l)),
  Uint8Array: UINT8_KIND,
  Uint8ClampedArray: viewKind(1, (b, o, l) => new Uint8ClampedArray(b, o, l)),
  Int16Array: viewKind(2, (b, o, l) => new Int16Array(b, o, l)),
  Uint16Array: viewKind(2, (b, o, l) => new Uint16Array(b, o, l)),
  Int32Array: viewKind(4, (b, o, l) => new Int32Array(b, o, l)),
  Uint32Array: viewKind(4, (b, o, l) => new Uint32Array(b, o, l)),
  Float32Array: viewKind(4, (b, o, l) => new Float32Array(b, o, l)),
  Float64Array: viewKind(8, (b, o, l) => new Float64Array(b, o, l)),
  DataView: DATA_VIEW_KIND,
  Buffer: UINT8_KIND,
  BigInt64Array: viewKind(8, (b, o, l) => new BigInt64Array(b, o, l)),
  BigUint64Array: viewKind(8, (b, o, l) => new BigUint64Array(b, o, l)),
  Float16Array: float16Kind(),
};

/** V8's native ArrayBufferView subtags, read when a view follows a buffer. */
const NATIVE_VIEW_SUBTAGS: ReadonlyMap<number, string> = new Map([
  [0x62, 'Int8Array'], // b
  [0x42, 'Uint8Array'], // B
  [0x43, 'Uint8ClampedArray'], // C
  [0x77, 'Int16Array'], // w
  [0x57, 'Uint16Array'], // W
  [0x64, 'Int32Array'], // d
  [0x44, 'Uint32Array'], // D
  [0x68, 'Float16Array'], // h
  [0x66, 'Float32Array'], // f
  [0x46, 'Float64Array'], // F
  [0x71, 'BigInt64Array'], // q
  [0x51, 'BigUint64Array'], // Q
  [0x3f, 'DataView'], // ?
]);
const VIEW_FLAG_LENGTH_TRACKING = 1;
const VIEW_FLAG_BACKED_BY_RAB = 2;

/** Smallest Smi range across 64-bit V8 builds (pointer compression). */
const SMI_MIN = -(2 ** 30);
const SMI_MAX = 2 ** 30 - 1;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
/** Trailing holes a sparse array may declare beyond its message's bytes. */
const SPARSE_ARRAY_HOLE_ALLOWANCE = 65_536;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isArrayIndexKey(key: string): boolean {
  return ARRAY_INDEX_PATTERN.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

function toStringTag(value: object): string {
  return Object.prototype.toString.call(value);
}

function unsupported(description: string): V8SerializationError {
  return new V8SerializationError(
    'unsupported_value',
    `${description} could not be serialized.`,
  );
}

function malformed(
  message = 'Serialized value is malformed.',
): V8SerializationError {
  return new V8SerializationError('malformed', message);
}

function defineData(
  target: object,
  key: string,
  value: unknown,
  enumerable = true,
): void {
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable,
      configurable: true,
    });
  } catch {
    throw malformed('Serialized value has an invalid property.');
  }
}

export interface V8SerializeOptions {
  /** Largest output; exceeding it throws `too_large` before allocating more. */
  maxBytes?: number;
  maxDepth?: number;
}

class Writer {
  private bytes = new Uint8Array(256);
  private length = 0;
  private readonly ids = new Map<object, number>();
  private nextId = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxDepth: number,
  ) {}

  result(): Bytes {
    return this.bytes.slice(0, this.length);
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed > this.maxBytes) {
      throw new V8SerializationError(
        'too_large',
        'Message is too large to send.',
      );
    }
    if (needed <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, this.maxBytes));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  byte(value: number): void {
    this.reserve(1);
    this.bytes[this.length] = value;
    this.length += 1;
  }

  raw(bytes: Uint8Array): void {
    this.reserve(bytes.byteLength);
    this.bytes.set(bytes, this.length);
    this.length += bytes.byteLength;
  }

  varint(value: number): void {
    let remaining = value;
    while (remaining >= 0x80) {
      this.byte((remaining % 0x80) | 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    this.byte(remaining);
  }

  double(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.raw(bytes);
  }

  header(): void {
    this.byte(TAG.version);
    this.varint(V8_SERIALIZATION_VERSION);
  }

  number(value: number): void {
    if (
      Number.isInteger(value) &&
      !Object.is(value, -0) &&
      value >= SMI_MIN &&
      value <= SMI_MAX
    ) {
      this.byte(TAG.int32);
      this.varint(((value << 1) ^ (value >> 31)) >>> 0);
      return;
    }
    this.byte(TAG.double);
    this.double(value);
  }

  bigintContents(value: bigint): void {
    const negative = value < BigInt(0);
    let magnitude = negative ? -value : value;
    const digits: number[] = [];
    while (magnitude > BigInt(0)) {
      digits.push(Number(magnitude & BigInt(0xff)));
      magnitude >>= BigInt(8);
    }
    while (digits.length % 8 !== 0) digits.push(0);
    this.varint(digits.length * 2 + (negative ? 1 : 0));
    this.raw(Uint8Array.from(digits));
  }

  string(value: string): void {
    let oneByte = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) > 0xff) {
        oneByte = false;
        break;
      }
    }
    if (oneByte) {
      this.byte(TAG.oneByteString);
      this.varint(value.length);
      this.reserve(value.length);
      for (let index = 0; index < value.length; index += 1) {
        this.bytes[this.length + index] = value.charCodeAt(index);
      }
      this.length += value.length;
      return;
    }
    const byteLength = value.length * 2;
    // V8 aligns two-byte string data to an even offset.
    if ((this.length + 1 + varintSize(byteLength)) % 2 === 1) {
      this.byte(TAG.padding);
    }
    this.byte(TAG.twoByteString);
    this.varint(byteLength);
    this.reserve(byteLength);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      this.bytes[this.length] = unit & 0xff;
      this.bytes[this.length + 1] = unit >>> 8;
      this.length += 2;
    }
  }

  propertyKey(key: string): void {
    if (isArrayIndexKey(key)) this.number(Number(key));
    else this.string(key);
  }

  value(value: unknown, depth: number): void {
    switch (typeof value) {
      case 'undefined':
        this.byte(TAG.undefined);
        return;
      case 'boolean':
        this.byte(value ? TAG.true : TAG.false);
        return;
      case 'number':
        this.number(value);
        return;
      case 'bigint':
        this.byte(TAG.bigint);
        this.bigintContents(value);
        return;
      case 'string':
        this.string(value);
        return;
      case 'symbol':
        throw unsupported('A symbol');
      case 'function':
        throw unsupported('A function');
      case 'object':
        if (value === null) this.byte(TAG.null);
        else this.receiver(value, depth);
        return;
    }
  }

  private receiver(value: object, depth: number): void {
    const existing = this.ids.get(value);
    if (existing !== undefined) {
      this.byte(TAG.objectReference);
      this.varint(existing);
      return;
    }
    if (depth > this.maxDepth) {
      throw new V8SerializationError(
        'too_deep',
        'Message is nested too deeply.',
      );
    }
    const write = this.classify(value);
    this.ids.set(value, this.nextId);
    this.nextId += 1;
    write(depth + 1);
  }

  /** Picks the writer for a receiver, or throws before assigning an ID. */
  private classify(value: object): (depth: number) => void {
    if (Array.isArray(value)) {
      const array: ReadonlyArray<unknown> = value;
      return (depth) => this.array(array, depth);
    }
    if (ArrayBuffer.isView(value)) return () => this.hostView(value);
    const tag = toStringTag(value);
    switch (tag) {
      case '[object Object]':
        return (depth) => this.plainObject(value, depth);
      case '[object ArrayBuffer]':
        return () => this.arrayBuffer(value);
      case '[object Date]': {
        const time = brand(() => Date.prototype.getTime.call(value), 'A Date');
        return () => {
          this.byte(TAG.date);
          this.double(time);
        };
      }
      case '[object RegExp]':
        return () => this.regExp(value);
      case '[object Map]': {
        const entries = brand((): Array<[unknown, unknown]> => {
          const items: Array<[unknown, unknown]> = [];
          for (const entry of Map.prototype.entries.call(value)) {
            const key: unknown = entry[0];
            const item: unknown = entry[1];
            items.push([key, item]);
          }
          return items;
        }, 'A Map');
        return (depth) => this.map(entries, depth);
      }
      case '[object Set]': {
        const values = brand((): unknown[] => {
          const items: unknown[] = [];
          for (const entry of Set.prototype.values.call(value)) {
            const item: unknown = entry;
            items.push(item);
          }
          return items;
        }, 'A Set');
        return (depth) => this.set(values, depth);
      }
      case '[object Error]':
        return (depth) => this.error(value, depth);
      case '[object Boolean]': {
        const flag = brand(
          () => Boolean.prototype.valueOf.call(value),
          'A Boolean',
        );
        return () => this.byte(flag ? TAG.trueObject : TAG.falseObject);
      }
      case '[object Number]': {
        const number = brand(
          () => Number.prototype.valueOf.call(value),
          'A Number',
        );
        return () => {
          this.byte(TAG.numberObject);
          this.double(number);
        };
      }
      case '[object String]': {
        const text = brand(
          () => String.prototype.valueOf.call(value),
          'A String',
        );
        return () => {
          this.byte(TAG.stringObject);
          this.string(text);
        };
      }
      case '[object BigInt]': {
        const big = brand(
          () => BigInt.prototype.valueOf.call(value),
          'A BigInt',
        );
        return () => {
          this.byte(TAG.bigintObject);
          this.bigintContents(big);
        };
      }
      default:
        throw unsupported(tag);
    }
  }

  private plainObject(value: object, depth: number): void {
    this.byte(TAG.beginJSObject);
    let count = 0;
    for (const key of Object.keys(value)) {
      this.propertyKey(key);
      this.value(Reflect.get(value, key), depth);
      count += 1;
    }
    this.byte(TAG.endJSObject);
    this.varint(count);
  }

  private array(value: ReadonlyArray<unknown>, depth: number): void {
    const keys = Object.keys(value);
    const named: string[] = [];
    let indices = 0;
    for (const key of keys) {
      if (isArrayIndexKey(key)) indices += 1;
      else named.push(key);
    }
    const length = value.length;
    if (indices === length) {
      this.byte(TAG.beginDenseJSArray);
      this.varint(length);
      for (let index = 0; index < length; index += 1) {
        this.value(value[index], depth);
      }
      for (const key of named) {
        this.string(key);
        this.value(Reflect.get(value, key), depth);
      }
      this.byte(TAG.endDenseJSArray);
      this.varint(named.length);
      this.varint(length);
      return;
    }
    this.byte(TAG.beginSparseJSArray);
    this.varint(length);
    for (const key of keys) {
      this.propertyKey(key);
      this.value(Reflect.get(value, key), depth);
    }
    this.byte(TAG.endSparseJSArray);
    this.varint(keys.length);
    this.varint(length);
  }

  private arrayBuffer(value: object): void {
    const byteLength = brand(() => {
      // The prototype getter with this receiver brand-checks the buffer.
      const length: unknown = Reflect.get(
        ArrayBuffer.prototype,
        'byteLength',
        value,
      );
      if (typeof length !== 'number')
        throw new TypeError('Not an ArrayBuffer.');
      return length;
    }, 'An ArrayBuffer');
    if (Reflect.get(value, 'detached') === true) {
      throw unsupported('A detached ArrayBuffer');
    }
    const bytes = new Uint8Array(byteLength);
    bytes.set(new Uint8Array(arrayBufferOf(value), 0, byteLength));
    const maxByteLength: unknown = Reflect.get(value, 'maxByteLength');
    if (
      Reflect.get(value, 'resizable') === true &&
      typeof maxByteLength === 'number'
    ) {
      this.byte(TAG.resizableArrayBuffer);
      this.varint(byteLength);
      this.varint(maxByteLength);
    } else {
      this.byte(TAG.arrayBuffer);
      this.varint(byteLength);
    }
    this.raw(bytes);
  }

  private hostView(view: ArrayBufferView): void {
    // A Node Buffer reports `[object Uint8Array]` and is written as one.
    const name = toStringTag(view).slice('[object '.length, -1);
    const index = WRITABLE_HOST_VIEW_NAMES.indexOf(name);
    if (index < 0) throw unsupported(`A ${name}`);
    this.byte(TAG.hostObject);
    this.varint(index);
    this.varint(view.byteLength);
    this.raw(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }

  private regExp(value: object): void {
    const source = brand(() => {
      // The prototype getter with this receiver brand-checks the RegExp.
      const text: unknown = Reflect.get(RegExp.prototype, 'source', value);
      if (typeof text !== 'string') throw new TypeError('Not a RegExp.');
      return text;
    }, 'A RegExp');
    const flagText: unknown = Reflect.get(value, 'flags');
    let flags = 0;
    if (typeof flagText === 'string') {
      for (const [letter, bit] of REGEXP_FLAGS) {
        if (flagText.includes(letter)) flags |= bit;
      }
    }
    this.byte(TAG.regExp);
    this.string(source);
    this.varint(flags);
  }

  private map(entries: ReadonlyArray<[unknown, unknown]>, depth: number): void {
    this.byte(TAG.beginJSMap);
    for (const [key, value] of entries) {
      this.value(key, depth);
      this.value(value, depth);
    }
    this.byte(TAG.endJSMap);
    this.varint(entries.length * 2);
  }

  private set(values: ReadonlyArray<unknown>, depth: number): void {
    this.byte(TAG.beginJSSet);
    for (const value of values) this.value(value, depth);
    this.byte(TAG.endJSSet);
    this.varint(values.length);
  }

  private error(value: object, depth: number): void {
    const messageDescriptor = Object.getOwnPropertyDescriptor(value, 'message');
    const causeDescriptor = Object.getOwnPropertyDescriptor(value, 'cause');
    this.byte(TAG.error);
    const prototypeTag = ERROR_PROTOTYPE_TAGS.get(
      String(Reflect.get(value, 'name')),
    );
    if (prototypeTag !== undefined) this.byte(prototypeTag);
    if (messageDescriptor !== undefined && 'value' in messageDescriptor) {
      this.byte(ERROR_TAG.message);
      this.string(String(messageDescriptor.value));
    }
    const stack: unknown = Reflect.get(value, 'stack');
    if (typeof stack === 'string') {
      this.byte(ERROR_TAG.stack);
      this.string(stack);
    }
    if (causeDescriptor !== undefined && 'value' in causeDescriptor) {
      this.byte(ERROR_TAG.cause);
      const cause: unknown = causeDescriptor.value;
      this.value(cause, depth);
    }
    this.byte(ERROR_TAG.end);
  }
}

function arrayBufferOf(value: object): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  // A buffer from another realm: copy through a view, which brand-checks it.
  const bytes: unknown = Reflect.construct(Uint8Array, [value]);
  if (!(bytes instanceof Uint8Array)) throw unsupported('An ArrayBuffer');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function brand<T>(read: () => T, description: string): T {
  try {
    return read();
  } catch {
    throw unsupported(description);
  }
}

function varintSize(value: number): number {
  let size = 1;
  let remaining = value;
  while (remaining >= 0x80) {
    size += 1;
    remaining = Math.floor(remaining / 0x80);
  }
  return size;
}

/** Serializes a value as Node's `v8.serialize` would, within `maxBytes`. */
export function serializeV8(
  value: unknown,
  options: V8SerializeOptions = {},
): Bytes {
  const writer = new Writer(
    options.maxBytes ?? MAX_MESSAGE_BYTES,
    options.maxDepth ?? V8_DEFAULT_MAX_DEPTH,
  );
  writer.header();
  writer.value(value, 0);
  return writer.result();
}

export interface V8DeserializeOptions {
  maxDepth?: number;
}

const STRING_CHUNK = 8_192;

class Reader {
  private offset = 0;
  private version = 0;
  private readonly objects = new Map<number, unknown>();
  private nextId = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxDepth: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private need(count: number): void {
    if (count > this.remaining)
      throw malformed('Serialized value is truncated.');
  }

  private rawByte(): number {
    this.need(1);
    const value = this.bytes[this.offset] ?? 0;
    this.offset += 1;
    return value;
  }

  header(): void {
    if (this.rawByte() !== TAG.version) {
      throw new V8SerializationError(
        'unsupported_version',
        'Serialized value has no version header.',
      );
    }
    this.version = this.varint();
    if (
      this.version < V8_MIN_READ_VERSION ||
      this.version > V8_MAX_READ_VERSION
    ) {
      throw new V8SerializationError(
        'unsupported_version',
        `Serialization format version ${this.version} is not supported.`,
      );
    }
  }

  finish(): void {
    while (this.remaining > 0) {
      if (this.rawByte() !== TAG.padding) {
        throw malformed('Serialized value has trailing bytes.');
      }
    }
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.rawByte();
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (value > 0xffffffff)
          throw malformed('Serialized length is too large.');
        return value;
      }
      scale *= 0x80;
    }
    throw malformed('Serialized varint is too long.');
  }

  private readTag(): number {
    let tag = this.rawByte();
    while (tag === TAG.padding) tag = this.rawByte();
    return tag;
  }

  private peekTag(): number {
    let position = this.offset;
    while (
      position < this.bytes.byteLength &&
      this.bytes[position] === TAG.padding
    ) {
      position += 1;
    }
    return position < this.bytes.byteLength ? (this.bytes[position] ?? -1) : -1;
  }

  private consumeTag(): void {
    this.readTag();
  }

  private double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  private slice(length: number): Bytes {
    this.need(length);
    // A copy even when the input is a Node Buffer, whose `slice` is a view.
    const output = new Uint8Array(length);
    output.set(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return output;
  }

  private reserveId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private register<T>(value: T): T {
    this.objects.set(this.reserveId(), value);
    return value;
  }

  value(depth: number): unknown {
    if (depth > this.maxDepth) {
      throw new V8SerializationError(
        'too_deep',
        'Message is nested too deeply.',
      );
    }
    const value = this.valueInternal(depth);
    if (
      value instanceof ArrayBuffer &&
      this.peekTag() === TAG.arrayBufferView
    ) {
      this.consumeTag();
      return this.nativeView(value);
    }
    return value;
  }

  private valueInternal(depth: number): unknown {
    const tag = this.readTag();
    switch (tag) {
      case TAG.verifyObjectCount:
        this.varint();
        return this.value(depth);
      case TAG.undefined:
        return undefined;
      case TAG.null:
        return null;
      case TAG.true:
        return true;
      case TAG.false:
        return false;
      case TAG.int32: {
        const zigzag = this.varint();
        return (zigzag >>> 1) ^ -(zigzag & 1);
      }
      case TAG.uint32:
        return this.varint();
      case TAG.double:
        return this.double();
      case TAG.bigint:
        return this.bigintContents();
      case TAG.utf8String:
      case TAG.oneByteString:
      case TAG.twoByteString:
        return this.stringContents(tag);
      case TAG.objectReference: {
        const id = this.varint();
        if (!this.objects.has(id))
          throw malformed('Serialized reference is invalid.');
        return this.objects.get(id);
      }
      case TAG.beginJSObject:
        return this.plainObject(depth);
      case TAG.beginDenseJSArray:
        return this.denseArray(depth);
      case TAG.beginSparseJSArray:
        return this.sparseArray(depth);
      case TAG.date: {
        const id = this.reserveId();
        const date = new Date(this.double());
        this.objects.set(id, date);
        return date;
      }
      case TAG.trueObject:
      case TAG.falseObject: {
        const wrapper: unknown = Object(tag === TAG.trueObject);
        return this.register(wrapper);
      }
      case TAG.numberObject: {
        const id = this.reserveId();
        const wrapper: unknown = Object(this.double());
        this.objects.set(id, wrapper);
        return wrapper;
      }
      case TAG.bigintObject: {
        const id = this.reserveId();
        const wrapper: unknown = Object(this.bigintContents());
        this.objects.set(id, wrapper);
        return wrapper;
      }
      case TAG.stringObject: {
        const id = this.reserveId();
        const wrapper: unknown = Object(this.string(depth));
        this.objects.set(id, wrapper);
        return wrapper;
      }
      case TAG.regExp:
        return this.regExp(depth);
      case TAG.beginJSMap:
        return this.map(depth);
      case TAG.beginJSSet:
        return this.set(depth);
      case TAG.arrayBuffer: {
        const id = this.reserveId();
        const length = this.varint();
        const buffer = this.slice(length).buffer;
        this.objects.set(id, buffer);
        return buffer;
      }
      case TAG.resizableArrayBuffer:
        return this.resizableArrayBuffer();
      case TAG.hostObject:
        return this.hostView();
      case TAG.error:
        return this.error(depth);
      case TAG.theHole:
      case TAG.arrayBufferView:
        throw malformed();
      default:
        throw new V8SerializationError(
          'unsupported_tag',
          `Serialized value tag 0x${tag.toString(16)} is not supported.`,
        );
    }
  }

  private bigintContents(): bigint {
    const bitfield = this.varint();
    const byteLength = Math.floor(bitfield / 2);
    const digits = this.slice(byteLength);
    // One hex parse keeps decoding linear; shifting in a byte at a time is
    // quadratic in the digit count, which a peer controls.
    const hex: string[] = [];
    for (let index = digits.byteLength - 1; index >= 0; index -= 1) {
      hex.push((digits[index] ?? 0).toString(16).padStart(2, '0'));
    }
    const value = hex.length === 0 ? BigInt(0) : BigInt(`0x${hex.join('')}`);
    return bitfield % 2 === 1 ? -value : value;
  }

  private stringContents(tag: number): string {
    const length = this.varint();
    this.need(length);
    const start = this.offset;
    this.offset += length;
    if (tag === TAG.utf8String) {
      return new TextDecoder('utf-8').decode(
        this.bytes.subarray(start, start + length),
      );
    }
    if (tag === TAG.oneByteString) {
      let output = '';
      for (let index = 0; index < length; index += STRING_CHUNK) {
        const end = Math.min(length, index + STRING_CHUNK);
        output += String.fromCharCode(
          ...this.bytes.subarray(start + index, start + end),
        );
      }
      return output;
    }
    if (length % 2 !== 0) throw malformed('Serialized string is malformed.');
    // Code units, not TextDecoder: lone surrogates must survive unchanged.
    let output = '';
    const units = new Array<number>(Math.min(STRING_CHUNK, length / 2));
    for (let unit = 0; unit < length / 2; unit += STRING_CHUNK) {
      const count = Math.min(STRING_CHUNK, length / 2 - unit);
      units.length = count;
      for (let index = 0; index < count; index += 1) {
        units[index] = this.view.getUint16(start + (unit + index) * 2, true);
      }
      output += String.fromCharCode(...units);
    }
    return output;
  }

  /** A nested value that must be a string (RegExp source, error fields). */
  private string(depth: number): string {
    const value = this.value(depth + 1);
    if (typeof value !== 'string')
      throw malformed('Serialized string is malformed.');
    return value;
  }

  private propertyKey(depth: number): string {
    const key = this.value(depth + 1);
    if (typeof key === 'string') return key;
    if (typeof key === 'number') return String(key);
    throw malformed('Serialized property key is invalid.');
  }

  private plainObject(depth: number): object {
    const object = this.register({});
    let count = 0;
    while (this.peekTag() !== TAG.endJSObject) {
      const key = this.propertyKey(depth);
      defineData(object, key, this.value(depth + 1));
      count += 1;
    }
    this.consumeTag();
    if (this.varint() !== count)
      throw malformed('Serialized object is malformed.');
    return object;
  }

  private arrayProperties(
    array: unknown[],
    endTag: number,
    depth: number,
  ): number {
    let count = 0;
    while (this.peekTag() !== endTag) {
      const key = this.propertyKey(depth);
      defineData(array, key, this.value(depth + 1));
      count += 1;
    }
    this.consumeTag();
    return count;
  }

  private denseArray(depth: number): unknown[] {
    const length = this.varint();
    // Every element takes at least one byte.
    this.need(length);
    const array = this.register(new Array<unknown>());
    for (let index = 0; index < length; index += 1) {
      if (this.peekTag() === TAG.theHole) {
        this.consumeTag();
        continue;
      }
      array[index] = this.value(depth + 1);
    }
    array.length = length;
    const count = this.arrayProperties(array, TAG.endDenseJSArray, depth);
    if (
      this.varint() !== count ||
      this.varint() !== length ||
      array.length !== length
    ) {
      throw malformed('Serialized array is malformed.');
    }
    return array;
  }

  private sparseArray(depth: number): unknown[] {
    const length = this.varint();
    // A sparse length costs a few bytes whatever its size, and later array
    // walks visit every hole, so it may not outgrow what the message holds.
    if (length > this.remaining + SPARSE_ARRAY_HOLE_ALLOWANCE)
      throw malformed('Serialized array is too long.');
    const array = this.register(new Array<unknown>());
    array.length = length;
    const count = this.arrayProperties(array, TAG.endSparseJSArray, depth);
    if (
      this.varint() !== count ||
      this.varint() !== length ||
      array.length !== length
    ) {
      throw malformed('Serialized array is malformed.');
    }
    return array;
  }

  private regExp(depth: number): RegExp {
    const id = this.reserveId();
    const source = this.string(depth);
    const bits = this.varint();
    if (
      (bits & ~REGEXP_KNOWN_FLAGS) !== 0 ||
      (bits & REGEXP_LINEAR_FLAG) !== 0
    ) {
      throw new V8SerializationError(
        'unsupported_tag',
        'RegExp flags are not supported.',
      );
    }
    let flags = '';
    for (const [letter, bit] of REGEXP_FLAGS) {
      if ((bits & bit) !== 0) flags += letter;
    }
    let expression: RegExp;
    try {
      expression = new RegExp(source, flags);
    } catch {
      throw malformed('Serialized RegExp is malformed.');
    }
    this.objects.set(id, expression);
    return expression;
  }

  private map(depth: number): Map<unknown, unknown> {
    const map = this.register(new Map<unknown, unknown>());
    let count = 0;
    while (this.peekTag() !== TAG.endJSMap) {
      const key = this.value(depth + 1);
      map.set(key, this.value(depth + 1));
      count += 2;
    }
    this.consumeTag();
    if (this.varint() !== count)
      throw malformed('Serialized Map is malformed.');
    return map;
  }

  private set(depth: number): Set<unknown> {
    const set = this.register(new Set<unknown>());
    let count = 0;
    while (this.peekTag() !== TAG.endJSSet) {
      set.add(this.value(depth + 1));
      count += 1;
    }
    this.consumeTag();
    if (this.varint() !== count)
      throw malformed('Serialized Set is malformed.');
    return set;
  }

  private resizableArrayBuffer(): ArrayBuffer {
    const id = this.reserveId();
    const byteLength = this.varint();
    const maxByteLength = this.varint();
    if (maxByteLength < byteLength || maxByteLength > MAX_MESSAGE_BYTES) {
      throw malformed('Serialized ArrayBuffer is malformed.');
    }
    const bytes = this.slice(byteLength);
    const buffer: unknown = Reflect.construct(ArrayBuffer, [
      byteLength,
      { maxByteLength },
    ]);
    if (!(buffer instanceof ArrayBuffer)) throw malformed();
    new Uint8Array(buffer).set(bytes);
    this.objects.set(id, buffer);
    return buffer;
  }

  private nativeView(buffer: ArrayBuffer): unknown {
    const subtag = this.varint();
    const byteOffset = this.varint();
    const byteLength = this.varint();
    const flags = this.version >= 14 ? this.varint() : 0;
    const name = NATIVE_VIEW_SUBTAGS.get(subtag);
    const kind = name === undefined ? undefined : VIEW_KINDS[name];
    if (kind === undefined || kind === null) {
      throw new V8SerializationError(
        'unsupported_tag',
        'Serialized view type is not supported.',
      );
    }
    if (
      (flags & ~(VIEW_FLAG_LENGTH_TRACKING | VIEW_FLAG_BACKED_BY_RAB)) !== 0 ||
      byteOffset + byteLength > buffer.byteLength ||
      byteOffset % kind.bytesPerElement !== 0 ||
      byteLength % kind.bytesPerElement !== 0
    ) {
      throw malformed('Serialized view is malformed.');
    }
    const lengthTracking = (flags & VIEW_FLAG_LENGTH_TRACKING) !== 0;
    return this.register(
      kind.create(buffer, byteOffset, lengthTracking ? null : byteLength),
    );
  }

  private hostView(): unknown {
    const id = this.reserveId();
    const index = this.varint();
    const byteLength = this.varint();
    const name = HOST_VIEW_NAMES[index];
    const kind = name === undefined ? undefined : VIEW_KINDS[name];
    if (kind === undefined || kind === null) {
      throw new V8SerializationError(
        'unsupported_tag',
        'Serialized host object is not supported.',
      );
    }
    if (byteLength % kind.bytesPerElement !== 0) {
      throw malformed('Serialized view is malformed.');
    }
    // A fresh, aligned buffer holding only the view's bytes.
    const view = kind.create(this.slice(byteLength).buffer, 0, byteLength);
    this.objects.set(id, view);
    return view;
  }

  private error(depth: number): Error {
    const id = this.reserveId();
    let constructor: ErrorConstructorLike = Error;
    let message: string | undefined;
    let stack: string | undefined;
    let error: Error | null = null;
    const build = (): Error => {
      const created = new constructor();
      if (message !== undefined) defineData(created, 'message', message, false);
      this.objects.set(id, created);
      return created;
    };
    for (;;) {
      const tag = this.varint();
      if (tag === ERROR_TAG.end) break;
      const prototype = ERROR_CONSTRUCTORS.get(tag);
      if (
        prototype !== undefined &&
        error === null &&
        tag !== ERROR_TAG.message
      ) {
        constructor = prototype;
        continue;
      }
      if (tag === ERROR_TAG.message && error === null) {
        message = this.string(depth);
      } else if (tag === ERROR_TAG.stack) {
        stack = this.string(depth);
      } else if (tag === ERROR_TAG.cause) {
        error ??= build();
        defineData(error, 'cause', this.value(depth + 1), false);
      } else {
        throw malformed('Serialized error is malformed.');
      }
    }
    error ??= build();
    defineData(error, 'stack', stack, false);
    return error;
  }
}

/** Deserializes Node `v8.serialize` output (format versions 13 to 16). */
export function deserializeV8(
  bytes: Uint8Array,
  options: V8DeserializeOptions = {},
): unknown {
  const reader = new Reader(bytes, options.maxDepth ?? V8_DEFAULT_MAX_DEPTH);
  reader.header();
  const value = reader.value(0);
  reader.finish();
  return value;
}
