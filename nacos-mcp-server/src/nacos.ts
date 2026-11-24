import {isUtf8} from 'node:buffer';
import type {Config} from './config.js';

export type FailureKind = 'connection' | 'login' | 'forbidden' | 'api';

export class Failure extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    /** HTTP status when Nacos answered, 0 otherwise. */
    readonly status = 0,
  ) {
    super(message);
    this.name = 'Failure';
  }
}

export interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
}

export type FormValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, FormValue>;
  /** Sent as application/x-www-form-urlencoded, which is what Nacos expects for almost everything. */
  form?: Record<string, FormValue>;
  body?: string | Blob | FormData;
  /** Of `body`; defaults to text/plain. */
  contentType?: string;
  headers?: Record<string, string>;
  /** Attach the access token; false for requests that must not carry one. */
  authenticate?: boolean;
}

/** Calls the Nacos HTTP API and hides everything about tokens and transport behind it. */
export class Nacos {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(readonly config: Config) {}

  async send(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<Reply> {
    const url = new URL(path.replace(/^\/+/, ''), `${this.config.address}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: '*/*', ...options.headers };
    const init: RequestInit = { method, headers };
    if (options.form !== undefined) {
      init.body = new URLSearchParams(clean(options.form)).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined) {
      init.body = options.body;
      // A FormData body brings its own content type, boundary included; any other needs one.
      if (!(options.body instanceof FormData)) headers['Content-Type'] = options.contentType ?? 'text/plain';
    }
    if (options.authenticate !== false && this.config.username) {
      headers.accessToken = await this.accessToken();
    }
    if (this.config.timeoutMs > 0) init.signal = AbortSignal.timeout(this.config.timeoutMs);

    const reply = await this.fetch(url, init);
    // "user not found!" is what Nacos answers to a missing or expired token: one fresh login is worth a try.
    const expired = reply.status === 403 && /user not found/.test(reply.body.toString('utf8'));
    if (expired && !retried && this.config.username && options.authenticate !== false) {
      this.token = undefined;
      return this.send(method, path, options, true);
    }
    return reply;
  }

  private async fetch(url: URL, init: RequestInit): Promise<Reply> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const why = reason(error, this.config.timeoutMs);
      throw new Failure(
        `Cannot reach Nacos at ${this.config.address}: ${why}. Is Nacos running, and is NACOS_ADDRESS right?`,
        'connection',
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) {
      return this.token.value;
    }
    const username = this.config.username ?? '';
    const reply = await this.fetch(new URL('v1/auth/login', `${this.config.address}/`), {
      method: 'POST',
      body: new URLSearchParams({ username, password: this.config.password ?? '' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (reply.status !== 200) {
      throw new Failure(
        `Nacos rejected the login of user "${username}": ${plain(reply.body.toString('utf8'))}. ` +
          'Check NACOS_USERNAME and NACOS_PASSWORD (leave both empty for a server without authentication).',
        'login',
        reply.status,
      );
    }
    const login = JSON.parse(reply.body.toString('utf8')) as { accessToken?: string; tokenTtl?: number };
    if (typeof login.accessToken !== 'string') {
      throw new Failure('Nacos accepted the login but sent no access token.', 'login', reply.status);
    }
    // Renewed a minute before it runs out; an unknown lifetime is assumed to be an hour.
    const ttl = Number.isFinite(login.tokenTtl) ? Math.max((login.tokenTtl ?? 0) - 60, 30) : 3600;
    this.token = { value: login.accessToken, expiresAt: Date.now() + ttl * 1000 };
    return login.accessToken;
  }
}

function clean(form: Record<string, FormValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

/** Walks the chain of causes: the fetch API wraps the real reason two levels deep and does not always expose its code. */
function reason(error: unknown, timeoutMs: number): string {
  const messages: string[] = [];
  for (let at = error; at !== null && at !== undefined && messages.length < 6; at = (at as { cause?: unknown }).cause) {
    const { code, name, message } = at as { code?: unknown; name?: unknown; message?: unknown };
    const text = `${String(code ?? '')} ${String(name ?? '')} ${String(message ?? '')}`;
    if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(text)) return 'connection refused';
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'the host name cannot be resolved';
    if (/CERT|SSL|TLS|self[- ]signed/i.test(text)) return 'its TLS certificate was not accepted';
    if (/ETIMEDOUT|TimeoutError|timed? ?out/i.test(text)) return `no answer within ${timeoutMs} ms`;
    messages.push((at as { message?: unknown }).message ? String((at as { message?: unknown }).message) : String(at));
  }
  return messages.join(': ');
}

/** Nacos quotes its error messages as HTML entities, wraps them in "caused: …;" and pads them with whitespace. */
export function plain(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\bcaused:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim();
}

/** The body of an error answer as an object, when Nacos sent JSON; its messages sit in different fields depending on the API generation. */
function describe(reply: Reply): string {
  const text = reply.body.toString('utf8');
  if (/json/i.test(reply.contentType)) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        const known = ['message', 'error', 'data', 'msg']
          .map((key) => parsed[key])
          .find((value): value is string => typeof value === 'string' && value.trim() !== '');
        if (known !== undefined) return plain(known);
      }
    } catch {
      // Not JSON after all: the raw text is used below.
    }
  }
  return plain(text);
}

/** Turns an error answer into a Failure that says what to do about it. */
export function failureOf(reply: Reply, path: string, config: Config): Failure {
  const raw = reply.body.toString('utf8');
  const message = describe(reply);
  if (reply.status === 403 && /user not found/i.test(raw)) {
    return new Failure(
      config.username
        ? `Nacos did not accept the login of user "${config.username}" (${message}). Check NACOS_USERNAME and NACOS_PASSWORD.`
        : `Nacos requires a login for that (${message}). Set NACOS_USERNAME and NACOS_PASSWORD.`,
      'login',
      reply.status,
    );
  }
  if (reply.status === 403) {
    return new Failure(`The Nacos user "${config.username ?? '?'}" is not allowed to do that: ${message}`, 'forbidden', reply.status);
  }
  // The embedded Derby store cannot run the SQL Nacos uses to read its namespaces, on every API that lists them.
  if (reply.status === 500 && /bad SQL grammar/i.test(raw) && /tenant_capacity/i.test(raw)) {
    return new Failure(
      'Nacos could not list its namespaces: it runs on its embedded Derby store, from which this Nacos version cannot read namespace information. ' +
        'Only the public namespace can be used with such a server; the others need a MySQL store.',
      'api',
      reply.status,
    );
  }
  // Outside its context path Nacos is a plain web server that answers with an HTML error page.
  const html = /^\s*(<!doctype\s+html|<html\b)/i.test(raw);
  // A 500 about an unsupported content type is a body in the wrong shape, not a missing API.
  const noSuchApi = [404, 405, 501].includes(reply.status) || /no such api/i.test(raw);
  if (noSuchApi) {
    const forWhat = reply.status === 501 || reply.status === 405 ? 'this HTTP method' : 'this path';
    const detail = html ? '' : ` (${message})`;
    const hint =
      reply.status === 404
        ? 'If this API should exist, NACOS_ADDRESS is probably missing the context path, which usually is "/nacos". '
        : 'Paths are given relative to the context path and start with v1/ or v2/. ';
    return new Failure(`Nacos has no API at "${path}" for ${forWhat}: HTTP ${reply.status}${detail}. ${hint}`, 'api', reply.status);
  }
  if (html) {
    return new Failure(
      `Nacos answered HTTP ${reply.status} with an HTML page instead of its usual answer. Check the path and how the body is sent.`,
      'api',
      reply.status,
    );
  }
  return new Failure(`Nacos answered HTTP ${reply.status}: ${message}`, 'api', reply.status);
}

/** True for the failure a server on the embedded Derby store answers whenever its namespaces are listed. */
export function isEmbeddedStore(error: unknown): boolean {
  return error instanceof Failure && error.message.startsWith('Nacos could not list its namespaces');
}

const SECRET_KEY = /^pass(word)?$/i;

/** Nacos hands out password hashes with its user list; those are of no use to a model and stay out of its context. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item)]));
  }
  return value;
}

/** The longest text handed back before it is cut off. */
const MAX_TEXT_CHARS = 60_000;

/** Makes a reply JSON-ready: JSON stays JSON (with password hashes removed), text is trimmed, binary becomes base64. */
export function decode(reply: Reply): unknown {
  const text = reply.body.toString('utf8');
  // Judged by the bytes as well as the declared type: content negotiation can label a zip export as JSON.
  const archive =
    reply.body.length > 4 && ((reply.body[0] === 0x50 && reply.body[1] === 0x4b) || (reply.body[0] === 0x1f && reply.body[1] === 0x8b));
  const binary = archive || /zip|octet-stream|image\/|audio\//.test(reply.contentType) || (reply.body.length > 0 && !isUtf8(reply.body));
  if (binary) {
    const shown = reply.body.subarray(0, 45_000);
    const hidden = reply.body.length - shown.length;
    return {
      base64: shown.toString('base64') + (hidden > 0 ? `…[${hidden} more bytes]` : ''),
      bytes: reply.body.length,
      content_type: reply.contentType,
    };
  }
  if (/json/i.test(reply.contentType)) {
    try {
      return redact(JSON.parse(text));
    } catch {
      // Not JSON after all: fall through and return it as text.
    }
  }
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[${text.length - MAX_TEXT_CHARS} more chars]` : text.trim();
}
