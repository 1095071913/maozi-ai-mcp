import {Buffer, isUtf8} from 'node:buffer';

/** Longest text or base64 handed back before it is cut off. */
const MAX_TEXT_CHARS = 4000;
/** Raw bytes that fit into that length as base64. */
const ENCODED_BYTES = 3000;
const BINARY_PREVIEW_BYTES = 48;
/** Control characters that practically never occur in text (tab, newline, CR, ESC and friends excepted). */
const BINARY_CHARACTER = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/;

export type CommandArg = string | Buffer;

/**
 * Accepts strings and numbers; `{ "base64": "…" }` carries raw bytes. Anything else is a
 * mistake worth stopping for, rather than sending "[object Object]" to Redis.
 */
export function decodeArgs(args: readonly unknown[]): CommandArg[] {
  return args.map((arg, index) => {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' && Number.isFinite(arg)) return String(arg);
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      const fields = Object.keys(arg);
      const base64 = (arg as { base64?: unknown }).base64;
      if (fields.length === 1 && fields[0] === 'base64' && typeof base64 === 'string') {
        // Buffer.from silently skips characters it does not like, so check that the text really was base64.
        const text = base64.replace(/\s+/g, '');
        const bytes = Buffer.from(text, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')) return bytes;
        throw new Error(`args[${index}]: not valid base64`);
      }
    }
    const kind =
      arg === null ? 'null' : Array.isArray(arg) ? 'an array' : typeof arg === 'object' ? 'an object other than { "base64": "…" }' : `a ${typeof arg}`;
    throw new Error(`args[${index}] must be a string, a number or { "base64": "…" }, got ${kind}`);
  });
}

/** A number as Redis prints it: an integer, a decimal, or scientific notation. */
const NUMERIC = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/**
 * Makes a reply JSON-ready. Values arrive as raw bytes and numbers as text: text that is valid
 * UTF-8 stays text, anything else becomes base64, and numbers become numbers again, except
 * integers beyond 2^53, which would lose digits and keep their exact text.
 */
export function encodeReply(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return asTextOrBinary(value);
  if (Array.isArray(value)) return value.map(encodeReply);
  if (typeof value === 'string' && NUMERIC.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  return value;
}

/** Turns Redis's flat `field, value, field, value…` reply into an object. */
export function pairsToObject(pairs: readonly unknown[]): Record<string, unknown> | unknown[] {
  if (pairs.length % 2 !== 0) return [...pairs];
  const object: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) {
    const field = pairs[i];
    if (typeof field !== 'string' || Object.hasOwn(object, field)) return [...pairs];
    object[field] = pairs[i + 1];
  }
  return object;
}

function clip(text: string, unit: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[${text.length - MAX_TEXT_CHARS} more ${unit}]` : text;
}

function asTextOrBinary(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  // Valid UTF-8 free of control characters reads as text; anything else is kept as the bytes it is.
  if (isUtf8(bytes) && !BINARY_CHARACTER.test(text)) return clip(text, 'chars');
  // Only the head is encoded: a multi-megabyte blob must not become an even longer string.
  const head = bytes.subarray(0, ENCODED_BYTES);
  const hidden = bytes.length - head.length;
  return { base64: clip(head.toString('base64'), 'chars') + (hidden > 0 ? `…[${hidden} more bytes]` : ''), bytes: bytes.length, preview: preview(bytes) };
}

/** The first bytes with non-printables escaped, so that a format (e.g. Java serialization) can be recognised. */
function preview(bytes: Buffer): string {
  let text = '';
  for (const byte of bytes.subarray(0, BINARY_PREVIEW_BYTES)) {
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return bytes.length > BINARY_PREVIEW_BYTES ? `${text}…` : text;
}
