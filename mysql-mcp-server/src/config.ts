import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';

/** Project root: dist/ sits one level below it. */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every setting this server reads, i.e. every name allowed in a settings file. */
const SETTINGS = [
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'MYSQL_MCP_READONLY',
  'MYSQL_MCP_QUERY_TIMEOUT_MS',
];
const KEY_VALUE_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;

export interface Config {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Database that unqualified table names resolve to; undefined leaves the choice to MySQL. */
  database?: string;
  /** Server-side time limit for SELECT statements; 0 disables it. */
  queryTimeoutMs: number;
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
 * know, is an error: falling back to a default silently could point a tool that drops tables at
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
 * that pointing the server at one database never mixes in the settings of another.
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
    host: setting('MYSQL_HOST') ?? '127.0.0.1',
    port: intSetting('MYSQL_PORT', setting('MYSQL_PORT'), 3306, 1, 65535),
    user: setting('MYSQL_USER') ?? 'root',
    password: setting('MYSQL_PASSWORD') ?? '',
    database: setting('MYSQL_DATABASE') || undefined,
    queryTimeoutMs: intSetting('MYSQL_MCP_QUERY_TIMEOUT_MS', setting('MYSQL_MCP_QUERY_TIMEOUT_MS'), 60_000, 0, 2_147_483_647),
    readonly: ['1', 'true', 'yes'].includes((setting('MYSQL_MCP_READONLY') ?? '').toLowerCase()),
    envFile: source === undefined ? undefined : file,
  };
}
