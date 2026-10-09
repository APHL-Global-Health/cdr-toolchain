// Scans every custom query of the pack the way CE's validateSelectSql does.
//
//   node packs/reports-zm/scan-sql.mjs
//
// For each query's `sql` and each parameter's `optionsSql`: no `--` anywhere (CE strips such text
// as a comment before checking), one statement, starts with select or with, and none of the banned
// words outside string literals. Prints `ok <name>` or `BAD <name>: <why>`; exits 1 on any BAD.
// It reads no database. Run it after every query change.

import { pathToFileURL } from 'node:url';
import { allQueries } from './all-queries.mjs';

const BANNED = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;

// Why `sql` would be refused, or null. Mirrors packages/dashboards/src/sql-runner.ts.
export function problem(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return 'empty';
  if (sql.includes('--')) return 'contains "--"';
  if (sql.includes('/*')) return 'contains a block comment';
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").trim().replace(/;\s*$/, '');
  if (stripped.includes(';')) return 'more than one statement';
  if (!/^(select|with)\b/i.test(stripped)) return 'does not start with select or with';
  const word = stripped.match(BANNED);
  if (word) return `banned word "${word[0]}" outside a literal`;
  return null;
}

export function scan(queries) {
  const lines = [];
  for (const q of queries) {
    const bad = [];
    const p = problem(q.sql);
    if (p) bad.push(p);
    for (const param of q.params ?? []) {
      if (param.optionsSql === undefined) continue;
      const o = problem(param.optionsSql);
      if (o) bad.push(`param ${param.id} optionsSql: ${o}`);
    }
    lines.push({ ok: bad.length === 0, text: bad.length === 0 ? `ok ${q.name}` : `BAD ${q.name}: ${bad.join('; ')}` });
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = scan(allQueries());
  for (const l of lines) console.log(l.text);
  process.exit(lines.every((l) => l.ok) ? 0 : 1);
}
