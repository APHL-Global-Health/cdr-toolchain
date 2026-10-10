// Fixture and suite helpers for the testing summaries by area (task 10: VL and EID, three levels each).
// The summaries read requests, reports and results only, so a fixture is a list of requests. Used by
// checks/vl.mjs (group t10) and checks/eid.mjs (group t10-eid).

import { lit, inOrder } from '../../shared/pg-check.mjs';

export const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

const num = (v) => (v === null || v === undefined ? 'null' : String(v));

// The facility_map rows of one group. `rows`: [code, name, region, district, mapped]. A row with mapped false
// has no register id, so the requesting facility is not in the register.
export function facilityRows(prefix, rows) {
  const values = rows.map(([code, name, region, district, mapped = true], i) =>
    `(${lit(`${prefix}-fm${i + 1}`)}, '', '', ${lit(code)}, ${mapped ? lit(`reg-${prefix}-${i + 1}`) : 'null::text'}, ${lit(name)}, ${lit(region)}, ${lit(district)})`);
  return `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ${values.join(',\n  ')};`;
}

// A fixture of requests. `defaults`: panel, status, req (requester code), auth (registered), ana (analysed),
// eff (collected), iss (authorised), results [{ obs, text, num, cmp, coded }]. `req(labId, overrides)` adds
// one request with one report (set noReport for none). `setup(facilitySql)` returns every insert.
export function epiFixture(prefix, defaults) {
  const requests = [];
  const reports = [];
  const results = [];
  let n = 0;
  function req(labId, o = {}) {
    const r = { ...defaults, ...o };
    n += 1;
    const qid = `${prefix}-q${n}`;
    requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.auth)}, ${lit(r.ana)}, ${lit(r.req)})`);
    if (!r.noReport) reports.push(`(${lit(`${prefix}-d${n}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)})`);
    r.results.forEach((x, i) => {
      results.push(`(${lit(`${prefix}-r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs ?? defaults.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
    });
  }
  return {
    req,
    setup: (facilitySql) => `${facilitySql}
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code) values
  ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued) values
  ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ${results.join(',\n  ')};`,
  };
}

// A suite over a query's rows: column order, then the rows IN ORDER (v1 orders its rows).
export function orderedSuite(name, sqlText, params, columns, expectedRows, setup = '') {
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${bind(sqlText, params)}) q;`,
    count: expectedRows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== expectedRows.length) failures.push(`expected ${expectedRows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const have = got.map(key);
      const want = expectedRows.map(key);
      if (have.length === want.length) {
        have.forEach((h, i) => { if (h !== want[i]) failures.push(`row ${i + 1}: expected ${want[i]}, got ${h}`); });
      } else {
        for (const x of want) if (!have.includes(x)) failures.push(`missing row ${x}`);
        for (const g of have) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      }
      return failures;
    },
  };
}

const BANNED = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;

// A suite over the declared shape of a query: its parameter ids in order, which are required, their types, and that
// the SQL is a plain read-only SELECT.
export function shapeSuite(name, query, wantIds, wantTypes) {
  return {
    name,
    count: 3 + wantIds.length,
    check() {
      if (!query) return [`query for ${name} is missing`];
      const bad = [];
      const ids = query.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(wantIds)) bad.push(`params: expected ${wantIds}, got ${ids}`);
      query.params.forEach((p, i) => {
        if (!p.required) bad.push(`${p.id} is required (v1 has no all-areas mode)`);
        if (p.type !== wantTypes[i]) bad.push(`${p.id}: expected type ${wantTypes[i]}, got ${p.type}`);
      });
      if (BANNED.test(query.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(query.sql)) bad.push('does not start with "with"');
      return bad;
    },
  };
}

// A suite that expects a query to FAIL (or, with wanted null, to run). The harness runs one psql script with ON_ERROR_STOP, so an error would
// stop every suite. This one wraps the query in a temporary function that runs it in a plpgsql block and returns the error text, and the
// suite compares that text. `query` is a { name, sql } object (undefined when the query is missing). `wanted` is a fragment the message
// must contain, or null for "no error". Used by checks/covid.mjs (Task 23) and every area's t30c group (date parameter validation).
export function errorSuite(name, query, params, wanted) {
  const body = query ? bind(query.sql, params) : 'select 1';
  return {
    name,
    sql: `create or replace function pg_temp.zm_err(q text) returns text language plpgsql as $f$ begin execute q; return 'no error'; exception when others then return sqlerrm; end $f$;
select ${lit(name)} || chr(9) || json_build_object('msg', pg_temp.zm_err($q$${body}$q$))::text;`,
    count: 1,
    check(rows) {
      if (!query) return [`the query of ${name} is missing`];
      const msg = rows[0]?.msg;
      if (wanted === null) return msg === 'no error' ? [] : [`expected no error, got ${msg}`];
      return typeof msg === 'string' && msg.includes(wanted) ? [] : [`expected an error containing "${wanted}", got ${msg}`];
    },
  };
}

// The message of a bad date parameter (zm-sql.mjs dateParamSql).
export const badDate = (id, value) => `${id} must be YYYY-MM-DD, got ${value}`;

// Date parameter validation (Task 30c, item A), for every query of an area that takes the `from` and `to` dates. Per query:
//   - a valid window runs;
//   - '09/10/2026' as `from` and 'yesterday' as `to` raise the error that names the parameter and shows the value;
//   - a required date left blank raises, an optional date left blank means no limit and raises nothing, also beside a valid date on the
//     other side, and a bad date beside a blank one still raises.
// The other parameters are blank, except those in DATE_ERROR_OTHER (a required choice). The line list validates date-times itself (Task 23).
const DATE_ERROR_OTHER = { test_type: 'VL', art_number: '', year: '2026' };
// `blankOk` lists queries whose required date still reads a blank value as no limit (the weekly W query's `from`, an old floor).
export function dateErrorSuites(prefix, queryList, { skip = [], blankOk = [] } = {}) {
  const out = [];
  for (const q of queryList) {
    if (skip.includes(q.name)) continue;
    const ps = q.params ?? [];
    const from = ps.find((p) => p.id === 'from');
    const to = ps.find((p) => p.id === 'to');
    if (!from) continue;
    const open = blankOk.includes(q.name);
    const base = { ...Object.fromEntries(ps.map((p) => [p.id, DATE_ERROR_OTHER[p.id] ?? ''])) };
    const win = { ...base, from: '2026-05-01', ...(to ? { to: '2026-05-31' } : {}) };
    const id = (k) => `${prefix}: ${q.name}: ${k}`;
    out.push(errorSuite(id('valid window'), q, win, null));
    out.push(errorSuite(id('from 09/10/2026'), q, { ...win, from: '09/10/2026' }, badDate('from', '09/10/2026')));
    if (from.required && !open) out.push(errorSuite(id('from blank (required)'), q, { ...win, from: '' }, badDate('from', '')));
    else {
      out.push(errorSuite(id('both blank'), q, { ...win, from: '', to: '' }, null));
      out.push(errorSuite(id('from blank, to given'), q, { ...win, from: '' }, null));
      out.push(errorSuite(id('from blank, to bad'), q, { ...win, from: '', to: 'yesterday' }, badDate('to', 'yesterday')));
    }
    if (!to) continue;
    out.push(errorSuite(id('to yesterday'), q, { ...win, to: 'yesterday' }, badDate('to', 'yesterday')));
    out.push(errorSuite(id('to 2026-02-30'), q, { ...win, to: '2026-02-30' }, badDate('to', '2026-02-30')));
    if (to.required) out.push(errorSuite(id('to blank (required)'), q, { ...win, to: '' }, badDate('to', '')));
    else {
      out.push(errorSuite(id('to blank, from given'), q, { ...win, to: '' }, null));
      out.push(errorSuite(id('from bad, to blank'), q, { ...win, from: '09/10/2026', to: '' }, badDate('from', '09/10/2026')));
    }
  }
  return out;
}
