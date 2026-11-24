export type StatementKind = 'read' | 'write' | 'unsupported';

export interface Classification {
  kind: StatementKind;
  /** Lower-cased first keyword of the statement, e.g. "select"; empty for a blank statement. */
  verb: string;
  /** `unsupported`: why the statement is refused. */
  reason?: string;
  /** `write`: why the statement needs `confirm`. */
  danger?: string;
}

const READ_VERBS = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain']);

// Everything else (SET, USE, transactions, temporary tables, KILL, SHUTDOWN, ...) is refused:
// session state would leak between pooled connections, and some statements only cause harm.
const WRITE_VERBS = new Set([
  'insert', 'update', 'delete', 'replace',
  'create', 'alter', 'drop', 'truncate', 'rename',
  'call', 'load',
  'grant', 'revoke', 'flush',
  'analyze', 'check', 'optimize', 'repair',
]);

/** A WHERE clause that is nothing but a tautology, i.e. every row matches. */
const TRIVIAL_WHERE = /\bwhere\s+(?:true|1\s*=\s*1|1)\s*(?:$|;|\border\b|\blimit\b)/i;

export function classify(sql: string): Classification {
  // MySQL executes the body of /*! ... */ comments, so they could hide a keyword from the checks below.
  if (sql.includes('/*!')) {
    return { kind: 'unsupported', verb: '', reason: 'executable comments (/*! ... */) are not supported' };
  }
  const masked = maskSql(sql).trim();
  const verb = /^[a-z]+/.exec(masked.toLowerCase())?.[0] ?? '';
  if (READ_VERBS.has(verb)) return { kind: 'read', verb };
  if (!WRITE_VERBS.has(verb)) {
    return {
      kind: 'unsupported',
      verb,
      reason: verb ? `"${verb.toUpperCase()}" is not a statement this server executes` : 'the statement is empty',
    };
  }
  if (verb === 'create' && /^create\s+temporary\b/i.test(masked)) {
    return {
      kind: 'unsupported',
      verb,
      reason: 'temporary tables belong to a single pooled connection and would be invisible to the next call',
    };
  }
  return { kind: 'write', verb, danger: writeDanger(verb, masked) };
}

function writeDanger(verb: string, masked: string): string | undefined {
  // Clauses inside parentheses belong to a subquery or an expression, not to the statement itself.
  const topLevel = stripParentheses(masked);
  if (verb === 'drop' || verb === 'truncate') {
    return 'drops or truncates a database object and cannot be undone';
  }
  if (verb === 'update' || verb === 'delete') {
    if (!/\bwhere\b/i.test(topLevel)) return 'has no WHERE clause, so every row of the table is at risk';
    if (TRIVIAL_WHERE.test(topLevel)) return 'has a WHERE clause that matches every row';
  }
  if (verb === 'alter' && /\bdrop\b/i.test(topLevel)) {
    return 'drops a column, index or constraint and cannot be undone';
  }
  return undefined;
}

/**
 * Replaces string literals with '' and drops comments, so keyword checks cannot be fooled by text
 * inside them. Quoted identifiers become `?`: a table called `where` must not count as a clause.
 */
export function maskSql(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < sql.length && sql[i] !== ch) i += ch !== '`' && sql[i] === '\\' ? 2 : 1;
      out += ch === '`' ? '`?`' : "''";
    } else if (ch === '#' || (ch === '-' && sql[i + 1] === '-' && isSpaceOrEnd(sql[i + 2]))) {
      // MySQL only treats "--" as a comment when whitespace or the end of input follows.
      const newline = sql.indexOf('\n', i);
      out += '\n';
      i = newline === -1 ? sql.length : newline;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? sql.length : end + 1;
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

const isSpaceOrEnd = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

function stripParentheses(masked: string): string {
  let depth = 0;
  let out = '';
  for (const ch of masked) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(depth - 1, 0);
    else if (depth === 0) out += ch;
  }
  return out;
}
