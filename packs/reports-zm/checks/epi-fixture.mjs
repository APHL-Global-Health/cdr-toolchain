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
