import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';

/** Project root: dist/ sits one level below it. */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every setting this server reads, i.e. every name allowed in a settings file. */
const SETTINGS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_USER',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'REDIS_MCP_READONLY',
  'REDIS_MCP_TIMEOUT_MS',
];
const KEY_VALUE_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;

export interface Config {
  host: string;
  port: number;
  /** ACL user; undefined means the default user. */
  username?: string;
  password?: string;
  /** Logical database that commands run on unless a call names another. */
  db: number;
  /** Upper bound on how long one command may wait for its reply; 0 disables it. */
  timeoutMs: number;
  /** When true the server exposes the read tools only. */
  readonly: boolean;
  /** The settings file that was read, if there was one. */
  envFile?: string;
}

export interface EnvFiles {
  /** File named with --env-file, if any. A relative path resolves against the working directory. */
  envFile?: string;
  /** File read when none is named; tests point this at a scratch file. */
  defaultEnvFile?: string;
}

/**
 * Parses the body of a .env file. A line that is not KEY=VALUE, or a name this server does not
 * know, is an error: falling back to a default silently could point a tool that deletes keys at
 * a different server than the one that was meant.
 */
export function parseEnvSource(source: string, origin: string): Record<string, string | undefined> {
  // A quoted value may span lines or contain "#", so quoted text is blanked before the line check.
  const lines = source.replace(/"[^"]*"|'[^']*'/g, '""').split(/\r?\n/);
  const junk = lines.find((line) => line.trim() !== '' && !line.trimStart().startsWith('#') && !KEY_VALUE_LINE.test(line));
  if (junk) {
    throw new Error(`${origin}: this line is not KEY=VALUE (quote values that contain spaces or #): ${junk.trim()}`);
  }
  const values = parseEnv(source);
  const unknown = Object.keys(values).filter((key) => !SETTINGS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${origin}: unknown setting ${unknown.join(', ')}. Known settings: ${SETTINGS.join(', ')}.`);
  }
  return values;
}

function intSetting(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function readEnvFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Resolves the connection settings: environment first, then the settings file, then the
 * defaults. A file named with --env-file replaces <project>/.env rather than adding to it, so
 * that pointing the server at one Redis never mixes in the settings of another.
 */
export function loadConfig({ envFile, defaultEnvFile = path.join(projectRoot, '.env') }: EnvFiles = {}): Config {
  const file = envFile === undefined ? defaultEnvFile : path.resolve(envFile);
  const source = readEnvFile(file);
  if (source === undefined && envFile !== undefined) {
    throw new Error(`${file} does not exist (it was named with --env-file)`);
  }
  const fromFile = source === undefined ? {} : parseEnvSource(source, file);
  // Variables already set in the environment win, so an `env` block in the client's MCP
  // config or a shell export always takes effect.
  const setting = (name: string): string | undefined => process.env[name] ?? fromFile[name];

  return {
    host: setting('REDIS_HOST') ?? '127.0.0.1',
    port: intSetting('REDIS_PORT', setting('REDIS_PORT'), 6379, 1, 65535),
    username: setting('REDIS_USER') || undefined,
    password: setting('REDIS_PASSWORD') || undefined,
    // Redis itself rejects an index beyond its `databases` setting.
    db: intSetting('REDIS_DB', setting('REDIS_DB'), 0, 0, 1_000_000),
    timeoutMs: intSetting('REDIS_MCP_TIMEOUT_MS', setting('REDIS_MCP_TIMEOUT_MS'), 30_000, 0, 2_147_483_647),
    readonly: ['1', 'true', 'yes'].includes((setting('REDIS_MCP_READONLY') ?? '').toLowerCase()),
    envFile: source === undefined ? undefined : file,
  };
}
