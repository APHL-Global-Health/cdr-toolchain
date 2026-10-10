// Shared SQL helpers and parameter builders for Zambia's reports. The query files in queries/ and
// slice 1's zm-queries.mjs import from here. Each helper returns SQL text (or a parameter object)
// for a custom query; none of them reads data.
//
// Query parameters appear in SQL as {{param.<id>}}. CE puts the value in as a quoted literal, and a
// blank optional parameter arrives as ''.

import { lit as sqlLit, rpt, inListSql, foldSql, isNumericSql } from '../vl-reports-mz/vl-queries.mjs';

export { sqlLit };

export const ZM_REGISTER_URL = 'urn:openldr:zm:facilities';
export const ATTR_SYSTEM = 'urn:openldr:cs:request-attribute';

// 'a', 'b' from ['a', 'b']: single quotes doubled.
export const sqlList = (values) => values.map(sqlLit).join(', ');

// A window on a date column: `expr ~ <date pattern> and left(expr, 10) >= from and left(expr, 10) <= to`. The date is the first ten
// characters of the stamp's own text (YYYY-MM-DD), so it is the LOCAL date: '2026-05-31T23:30:00+02:00' and
// '2026-05-31T23:59:59Z' are both on 05-31. A NULL stamp is outside, and so is a stamp that does not start with a full date (a partial
// FHIR dateTime such as '2026-07', which as text would sort inside a June to July window). The parameters are YYYY-MM-DD.
// `extraDays` moves the end of the window later by that many days, for the v1 reports that add a day to
// their end date (the dashboard procedures run @EDate = dateadd(dd, 1, @EDate)). It is 0 for every other caller.
export function inRange(expr, fromParam = 'from', toParam = 'to', extraDays = 0) {
  if (!Number.isInteger(extraDays) || extraDays < 0) throw new Error('inRange: extraDays must be a whole number, 0 or more');
  const end = extraDays === 0 ? `{{param.${toParam}}}` : `to_char(({{param.${toParam}}})::date + ${extraDays}, 'YYYY-MM-DD')`;
  return `${expr} ~ ${DATE_START} and left(${expr}, 10) >= {{param.${fromParam}}} and left(${expr}, 10) <= ${end}`;
}

// ---- Parameters ----

// The picker queries run through CE's validateSelectSql and use the first column of each row.
export const provinceOptionsSql = (registerUrl) =>
  `select distinct region from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and region is not null and region <> '' order by region`;
export const districtOptionsSql = (registerUrl) =>
  `select distinct district from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and district is not null and district <> '' order by district`;

export const provinceParam = (id = 'province', required = false, registerUrl = ZM_REGISTER_URL) =>
  ({ id, label: 'Province (blank for all)', type: 'select', required, optionsSql: provinceOptionsSql(registerUrl) });
export const districtParam = (id = 'district', required = false, registerUrl = ZM_REGISTER_URL) =>
  ({ id, label: 'District (blank for all)', type: 'select', required, optionsSql: districtOptionsSql(registerUrl) });
// A text box, matched on the register name of the requesting facility (see areaFilter).
export const facilityParam = () =>
  ({ id: 'facility', label: 'Facility (name as in the register; blank for all)', type: 'text', required: false });
// A text box, matched on the testing lab code (diagnostic_reports.performer). CE has no Zambia lab register.
export const labParam = () =>
  ({ id: 'laboratory', label: 'Laboratory code (blank for all)', type: 'text', required: false });
// The from/to pair. `required` is true where v1 had a window.
export const dateParams = (required = true) => [
  { id: 'from', label: 'Date from (YYYY-MM-DD)', type: 'text', required },
  { id: 'to', label: 'Date to (YYYY-MM-DD)', type: 'text', required },
];

// ---- The requesting facility ----

// Join a lab request (`lrAlias`) to its mapped ZMFAC register row (`fmAlias`). Requests whose
// facility is not mapped drop out, as v1's inner joins drop facilities missing from its dictionary.
// `kind` 'left join' keeps them with empty facility columns, as a v1 left join does.
export const requesterJoin = (lrAlias, fmAlias, kind = 'join') =>
  `${kind} facility_map ${fmAlias} on ${fmAlias}.source_system = coalesce(${lrAlias}.source_system, '') and ${fmAlias}.performer_system = coalesce(${lrAlias}.requester_system, '') and ${fmAlias}.source_code = ${lrAlias}.requester_code and ${fmAlias}.registry_id is not null`;

// Conditions for the optional area parameters against the mapped row `fmAlias`. Each key of `ids`
// is the id of a parameter to apply (leave a key out to skip that filter). Returns SQL joined with
// "and", or `true` when no filter is asked for. Province and district compare as given; the
// facility compares on the register name ignoring case and trailing spaces, as SQL Server does.
export function areaFilter(ids = {}, fmAlias = 'fmr') {
  const blank = (p) => `{{param.${p}}} = ''`;
  const parts = [];
  if (ids.province) parts.push(`(${blank(ids.province)} or ${fmAlias}.region = {{param.${ids.province}}})`);
  if (ids.district) parts.push(`(${blank(ids.district)} or ${fmAlias}.district = {{param.${ids.district}}})`);
  if (ids.facility) parts.push(`(${blank(ids.facility)} or lower(rtrim(${fmAlias}.name)) = lower(rtrim({{param.${ids.facility}}})))`);
  return parts.length > 0 ? parts.join('\n    and ') : 'true';
}

// Area parameters of the dashboard-style reports, which take the area as optional parameters on the mapped names (not areaFilter's
// register row). An optional parameter arrives as '' when blank. `same` matches a column on a parameter the way SQL Server compares
// text (case and trailing spaces ignored) and passes everything when the parameter is blank.
export const given = (id) => `{{param.${id}}} <> ''`;
export const blank = (id) => `{{param.${id}}} = ''`;
export const same = (column, id) => `(${blank(id)} or ${foldSql(column)} = ${foldSql(`{{param.${id}}}`)})`;
// v1's `sum(case when <cond> then 1 else 0 end)`, and a float division with a zero guard (nullif).
export const count1 = (cond) => `sum(case when ${cond} then 1 else 0 end)`;
export const ratio = (top, bottom) => `(${top})::float8 / nullif(${bottom}, 0)`;

// The two request attributes of the v1 ART number, one row per request. Returns a CTE item
// `name as (...)` to put in a `with` list.
export const zmIdsCte = (name) => `${name} as (
  select a.lab_request_id,
    max(case when a.code = 'reference-numbers' then a.value_text end) as reference_numbers,
    max(case when a.code = 'unique-id' then a.value_text end) as unique_id
  from lab_request_attributes a
  where a.system = ${sqlLit(ATTR_SYSTEM)} and a.code in ('reference-numbers', 'unique-id')
  group by a.lab_request_id
)`;

// ---- The ART number ----

// SQL Server's REPLACE ignores case under the default collation, so v1's replace(x, 'AT.', '')
// also removes 'at.'. Postgres replace() is case-sensitive, so that step is a regexp. The order of
// the steps is v1's: commas, then 'AT.', then spaces, then dashes.
const dropCommaAt = (x) => `regexp_replace(replace(${x}, ',', ''), 'AT\\.', '', 'gi')`;
const stripRef = (x) => `replace(replace(${dropCommaAt(x)}, ' ', ''), '-', '')`;
const stripId = (x) => `replace(replace(${x}, ' ', ''), '-', '')`;

// The ART number, v1 sp_GetPreviousVLResultforCohort2x. `ref` is REFNO and `uniqueId` UNIQUEID,
// both SQL text that is never NULL ('' when not sent). v1 LIKE ignores case, so ilike.
//   1. REFNO starts ",ELABS": the text after the first "T.". Follows v1's LEN/RIGHT arithmetic: LEN ignores
//      trailing spaces, RIGHT counts them.
//   2. REFNO contains ",ELABS": the part before ",elabs", less its first 3 characters. Follows v1's LEN/RIGHT
//      arithmetic. (v1 errors when that part is under 3 characters; port gives ''.)
//   3. v1: REFNO blank and HOSPID set gives HOSPID. HOSPID is not sent yet (spec section 3), so
//      this rule never fires and a blank REFNO falls to rule 4.
//   4. REFNO blank after stripping: UNIQUEID without spaces and dashes.
//   5. REFNO, less commas and "AT.", starts "ART." or "ELABS.": UNIQUEID without spaces and dashes.
//   6. Otherwise REFNO without commas, "AT.", spaces and dashes.
export function artNumberSql(ref, uniqueId) {
  return `case
    when ${ref} ilike ',ELABS%' then right(${ref}, greatest(length(rtrim(${ref})) - strpos(upper(${ref}), 'T.') - 1, 0))
    when ${ref} ilike '%,ELABS%' then right(left(${ref}, strpos(lower(${ref}), ',elabs') - 1), greatest(length(rtrim(left(${ref}, strpos(lower(${ref}), ',elabs') - 1))) - 3, 0))
    when ${stripRef(ref)} = '' then ${stripId(uniqueId)}
    when ${dropCommaAt(ref)} ilike 'ART.%' or ${dropCommaAt(ref)} ilike 'ELABS.%' then ${stripId(uniqueId)}
    else ${stripRef(ref)}
  end`;
}

// Two shorter ART number rules. v1 repeats the rule in three procedures and each copy differs. Both read `ref` and
// `uniqueId` as in artNumberSql (never NULL), and both skip the HOSPID steps: HOSPID is not sent (spec ruling 7), so it
// is read as blank. A blank HOSPID sends a blank REFNO to UNIQUEID, which is rule 2 of each; if v1 held a HOSPID for
// such a client, v1 shows the HOSPID where the port shows UNIQUEID.

// v1 sp_GetDetailsFromARTNumber lines 22-28: the rule of artNumberSql without its two ",ELABS" text-extraction steps.
//   1. REFNO blank after removing commas, "AT.", spaces and dashes: UNIQUEID without spaces and dashes.
//   2. REFNO, less commas and "AT.", starts "ART." or "ELABS.": UNIQUEID without spaces and dashes.
//   3. Otherwise REFNO without commas, "AT.", spaces and dashes.
export function artNumberShortSql(ref, uniqueId) {
  return `case
    when ${stripRef(ref)} = '' then ${stripId(uniqueId)}
    when ${dropCommaAt(ref)} ilike 'ART.%' or ${dropCommaAt(ref)} ilike 'ELABS.%' then ${stripId(uniqueId)}
    else ${stripRef(ref)}
  end`;
}

// v1 sp_getFacilityVLClientDetails lines 28-34: the same, but spaces and dashes are never removed.
//   1. REFNO, less commas and "AT.", is blank (a text of spaces counts as blank): UNIQUEID as it is.
//   2. That text starts "ART." or "ELABS.": UNIQUEID as it is.
//   3. Otherwise that text, spaces and dashes kept.
export function artNumberRawSql(ref, uniqueId) {
  return `case
    when rtrim(${dropCommaAt(ref)}) = '' then ${uniqueId}
    when ${dropCommaAt(ref)} ilike 'ART.%' or ${dropCommaAt(ref)} ilike 'ELABS.%' then ${uniqueId}
    else ${dropCommaAt(ref)}
  end`;
}

// ---- Small v1 functions ----

// v1 dbo.getGenderFromSexCode. The comparison ignores case and trailing spaces, as SQL Server's does.
export const genderSql = (sexExpr) => `case upper(rtrim(${sexExpr}))
    when 'F' then 'Female' when 'M' then 'Male' when 'N' then 'Not Applicable' when 'O' then 'Other'
    when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Not Specified'
  end`;

// v1 dbo.Agegroup, exactly. Its 45 to 54 branch is labelled '45-49', so ages 50 to 54 never reach
// '50+' (spec ruling 1: kept). A NULL age gives 'Not Captured', as in v1 where every test is unknown.
export function ageGroupSql(yearsExpr) {
  const a = `(${yearsExpr})`;
  return `case
    when ${a} < 1 then '<1'
    when ${a} between 1 and 4 then '1-4'
    when ${a} between 5 and 9 then '5-9'
    when ${a} between 10 and 14 then '10-14'
    when ${a} between 15 and 19 then '15-19'
    when ${a} between 20 and 24 then '20-24'
    when ${a} between 25 and 29 then '25-29'
    when ${a} between 30 and 34 then '30-34'
    when ${a} between 35 and 39 then '35-39'
    when ${a} between 40 and 44 then '40-44'
    when ${a} between 45 and 54 then '45-49'
    when ${a} >= 50 then '50+'
    else 'Not Captured'
  end`;
}

// ---- Data from CE's own tables ----

export const VL_FORM_CODE = 'hiv_vl_documentation';

// The text answer of one VIRAL form question for a request (spec ruling 6). CE keeps the answers
// of Zambia's VIRAL panel as one questionnaire_responses row per request: `items` is a JSON array
// of { linkId: <observation code>, answer: [{ valueString } | { valueDecimal }] }. Returns the first
// answer's valueString, else its valueDecimal as text, else NULL. `requestIdExpr` is the lab
// request's id. If a request has several responses, the latest authored one is used.
export const formAnswerSql = (requestIdExpr, observationCode) => `(select coalesce(zit.item -> 'answer' -> 0 ->> 'valueString', zit.item -> 'answer' -> 0 ->> 'valueDecimal')
    from questionnaire_responses zqr
    cross join lateral jsonb_array_elements(zqr.items::jsonb) as zit(item)
    where zqr.form_code = ${sqlLit(VL_FORM_CODE)} and zqr.based_on_id = ${requestIdExpr} and zit.item ->> 'linkId' = ${sqlLit(observationCode)}
    order by zqr.authored desc nulls last, zqr.id
    limit 1)`;

// The testing laboratory's name (spec ruling 8): the report's performer_display, else the register
// name of the performer's mapped facility, else the performer's code. `drAlias` is a
// diagnostic_reports alias. A blank display counts as missing.
export const labNameSql = (drAlias) => `coalesce(
    case when btrim(${drAlias}.performer_display) <> '' then ${drAlias}.performer_display end,
    (select zfm.name from facility_map zfm
      where zfm.source_system = coalesce(${drAlias}.source_system, '') and zfm.performer_system = coalesce(${drAlias}.performer_system, '')
        and zfm.source_code = ${drAlias}.performer and zfm.registry_id is not null
      order by zfm.id limit 1),
    ${drAlias}.performer)`;

// ---- Text order like SQL Server ----

// SQL_Latin1_General_CP1_CI_AS (the server default, option sqlCollation): the order of the 191 Latin-1 characters (32 to 126 and 160 to
// 255), measured on the local SQL Server (sqlserver-varchar-char-ranks.json in the task folder). Each string holds the characters that
// compare equal (a capital and its small letter); the index is the rank. A hyphen, an apostrophe and a dot sort as any other mark.
const SS_VARCHAR_CLASSES = [
  " ",
  "!",
  "\"",
  "#",
  "$",
  "%",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  ".",
  "/",
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "_",
  "`",
  "{",
  "|",
  "}",
  "~",
  "\u00a0",
  "\u00a1",
  "\u00a2",
  "\u00a3",
  "\u00a4",
  "\u00a5",
  "\u00a6",
  "\u00a7",
  "\u00a8",
  "\u00a9",
  "\u00aa",
  "\u00ab",
  "\u00ac",
  "\u00ad",
  "\u00ae",
  "\u00af",
  "\u00b0",
  "\u00b1",
  "\u00b2",
  "\u00b3",
  "\u00b4",
  "\u00b5",
  "\u00b6",
  "\u00b7",
  "\u00b8",
  "\u00b9",
  "\u00ba",
  "\u00bb",
  "\u00bc",
  "\u00bd",
  "\u00be",
  "\u00bf",
  "\u00d7",
  "\u00f7",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "aA",
  "\u00e0\u00c0",
  "\u00c1\u00e1",
  "\u00e2\u00c2",
  "\u00c3\u00e3",
  "\u00e4\u00c4",
  "\u00c5\u00e5",
  "\u00e6\u00c6",
  "Bb",
  "cC",
  "\u00c7\u00e7",
  "Dd",
  "eE",
  "\u00e8\u00c8",
  "\u00c9\u00e9",
  "\u00ea\u00ca",
  "\u00cb\u00eb",
  "Ff",
  "gG",
  "Hh",
  "iI",
  "\u00ec\u00cc",
  "\u00cd\u00ed",
  "\u00ee\u00ce",
  "\u00cf\u00ef",
  "Jj",
  "kK",
  "Ll",
  "mM",
  "Nn",
  "\u00d1\u00f1",
  "oO",
  "\u00f2\u00d2",
  "\u00d3\u00f3",
  "\u00f4\u00d4",
  "\u00d5\u00f5",
  "\u00f6\u00d6",
  "\u00d8\u00f8",
  "Pp",
  "qQ",
  "Rr",
  "sS",
  "\u00df",
  "Tt",
  "uU",
  "\u00f9\u00d9",
  "\u00da\u00fa",
  "\u00fb\u00db",
  "\u00dc\u00fc",
  "Vv",
  "wW",
  "Xx",
  "yY",
  "\u00fd\u00dd",
  "\u00ff",
  "Zz",
  "\u00f0\u00d0",
  "\u00fe\u00de",
];

// Latin1_General_CI_AS (the default of ssTextKey), measured the same way (sqlserver-nvarchar-char-ranks.json). This is the Windows word sort,
// which SQL Server uses for nvarchar and for varchar columns of a Windows collation: the hyphen, the apostrophe and the soft hyphen are
// ignored in a comparison ('co-op' ties with 'coop' and only then comes after it), and marks such as '_' and '<' rank differently from
// the SQL collation ('_' before '<'). The name SS_NVARCHAR_CLASSES is kept from the first measurement.
const SS_NVARCHAR_CLASSES = [
  " ",
  "'",
  "-",
  "\u00ad",
  "\u00a0",
  "!",
  "\"",
  "#",
  "$",
  "%",
  "&",
  "(",
  ")",
  "*",
  ",",
  ".",
  "/",
  ":",
  ";",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "_",
  "`",
  "{",
  "|",
  "}",
  "~",
  "\u00a1",
  "\u00a6",
  "\u00a8",
  "\u00af",
  "\u00b4",
  "\u00b8",
  "\u00bf",
  "+",
  "<",
  "=",
  ">",
  "\u00b1",
  "\u00ab",
  "\u00bb",
  "\u00d7",
  "\u00f7",
  "\u00a2",
  "\u00a3",
  "\u00a4",
  "\u00a5",
  "\u00a7",
  "\u00a9",
  "\u00ac",
  "\u00ae",
  "\u00b0",
  "\u00b5",
  "\u00b6",
  "\u00b7",
  "0",
  "\u00bc",
  "\u00bd",
  "\u00be",
  "\u00b91",
  "2\u00b2",
  "\u00b33",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "Aa",
  "\u00aa",
  "\u00c1\u00e1",
  "\u00c0\u00e0",
  "\u00c2\u00e2",
  "\u00c4\u00e4",
  "\u00c3\u00e3",
  "\u00c5\u00e5",
  "\u00e6\u00c6",
  "bB",
  "Cc",
  "\u00c7\u00e7",
  "dD",
  "\u00d0\u00f0",
  "Ee",
  "\u00c9\u00e9",
  "\u00e8\u00c8",
  "\u00ca\u00ea",
  "\u00eb\u00cb",
  "fF",
  "Gg",
  "hH",
  "Ii",
  "\u00cd\u00ed",
  "\u00ec\u00cc",
  "\u00ce\u00ee",
  "\u00ef\u00cf",
  "jJ",
  "Kk",
  "lL",
  "Mm",
  "nN",
  "\u00d1\u00f1",
  "Oo",
  "\u00ba",
  "\u00d3\u00f3",
  "\u00f2\u00d2",
  "\u00d4\u00f4",
  "\u00f6\u00d6",
  "\u00d5\u00f5",
  "\u00f8\u00d8",
  "pP",
  "Qq",
  "rR",
  "Ss",
  "\u00df",
  "tT",
  "\u00de\u00fe",
  "Uu",
  "\u00da\u00fa",
  "\u00f9\u00d9",
  "\u00db\u00fb",
  "\u00fc\u00dc",
  "vV",
  "Ww",
  "xX",
  "Yy",
  "\u00dd\u00fd",
  "\u00ff",
  "zZ",
];
const SS_NVARCHAR_IGNORED = ["'", '-', '\u00ad'];

// A SQL string literal in ASCII only: U&'\0041' escapes, so no quote, backslash or double dash in the text.
const unicodeLiteral = (s) => "U&'" + [...s].map((c) => '\\' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + "'";

// The two strings of translate(): the characters of every class, and the character U+3000 + rank each maps to. Characters that
// translate() drops (the ignored ones) come last, with no partner.
function translation(classes, ignored) {
  const from = [];
  const to = [];
  classes.forEach((chars, rank) => {
    for (const c of chars) {
      if (ignored.includes(c)) continue;
      from.push(c);
      to.push(String.fromCharCode(0x3000 + rank));
    }
  });
  return { from: unicodeLiteral(from.concat(ignored).join('')), to: unicodeLiteral(to.join('')) };
}
const SS_KEYS = { false: translation(SS_NVARCHAR_CLASSES, SS_NVARCHAR_IGNORED), true: translation(SS_VARCHAR_CLASSES, []) };

// A text expression whose byte order (`collate "C"`) is SQL Server's text order:
//   order by ssTextKey(x) collate "C"      and      max by ssTextKey(x) collate "C"
// The default is the Windows word sort of the collation Latin1_General_CI_AS. Tanzania's v1 OpenLDRData text columns (LIMSRptResult,
// RequestID, the Requests columns) are varchar with exactly that collation (measured on the local SQL Server: the probe list sorted
// as nvarchar and as varchar under Latin1_General_CI_AS gives one order, with the Latin1_General_CI_AS word sort), so v1's MAX, ORDER BY
// and row_number over text follow it. Zambia is assumed to be the same (same v1 schema). `{ sqlCollation: true }` gives the order of
// a column in the server default collation SQL_Latin1_General_CP1_CI_AS (the old default), which the key's tests also pin.
// SQL Server ignores trailing spaces and case: the key trims trailing spaces and maps every character to the code point U+3000 plus
// the rank of its class (3 bytes in UTF-8, so the byte order follows the rank). Equal keys are equal texts for SQL Server ('abc' and
// 'ABC ' tie); break the tie with the plain text.
// Limits. A character outside the table (control characters, anything above U+00FF) is left as it is: it sorts before every mapped
// character when it is below U+3000, and after them above that (rare in lab data). In the word sort SQL Server ignores hyphens, apostrophes
// and the soft hyphen when it compares and uses them only to break a tie: the key drops them, so 'co-op' and 'coop' tie where SQL Server
// puts 'coop' first (break the tie on the plain text; that puts 'co-op' first, which SQL Server does not). SQL Server also compares
// letters before accents: the key sorts an accented letter as its own letter after the plain one, so 'ea' sorts before '\u00e9a' and
// 'eb' after it where SQL Server puts '\u00e9a' before 'eb'. A per-character key cannot reproduce either.
export const ssTextKey = (expr, { sqlCollation = false } = {}) =>
  `translate(rtrim(${expr}), ${SS_KEYS[sqlCollation].from}, ${SS_KEYS[sqlCollation].to})`;

// ---- The hivvl copy table (spec ruling 5) ----

// v1 sp_update_HIVVLTable: the three result lists (lines 124, 87, 95). v1 compares with SQL Server's
// default collation, so inListSql ignores case and trailing spaces.
const HIVVL_VALID = ['<20 copies/mL', 'TAR', 'Target not detected', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected',
  '<30 copies/ml', '<30 copies/mL', '<40 copies/mL', 'NDET', 'ND', '<20CP', '<400 copies/mL', '< 40', 'PTLTT', 'PTLTV'];
const HIVVL_SUPPRESSED = ['<20 copies/mL', 'TAR', 'Target not detected', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected',
  '<30 copies/ml', '<30 copies/mL', '<40 copies/mL', 'NDET', 'DET', 'ND', '<20CP', '< 40', '<400 copies/mL', '<883 copies/mL', 'PLTT', 'PTLTV'];
const HIVVL_UU = ['TAR', 'Target Not Detected', 'Target not detected', 'TARG', 'RNA not detected', 'NDET', 'ND', 'DET'];
export const YES_WORDS = ['Yes', 'Y', 'Yest'];

// Stamps are CE's ISO text, and DISA's local wall time keeps its offset ('2026-05-01T01:00:00+02:00').
// A FHIR dateTime may also be partial ('2026-07') or a date. Every cast is guarded: text that is not
// the full pattern gives NULL and never raises.
const FULL_STAMP = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'";
const DATE_START = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}'";
/** SQL for the LOCAL calendar date of a stamp, from its own text (v1 datediff(dd) counts local dates). NULL if no date. */
export const localDate = (x) => `(case when ${x} ~ ${DATE_START} then left(${x}, 10)::date end)`;
/** SQL for the local wall time of a stamp (offset dropped), for ordering as v1 does. A date-only stamp is midnight; a partial one is NULL. */
export const localTs = (x) => `coalesce(substring(${x} from '^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?)')::timestamp, ${localDate(x)}::timestamp)`;
/** SQL for a UTC timestamp of a full stamp (NULL otherwise), for hour differences; the offsets are fixed whole hours. */
export const utcTs = (x) => `(case when ${x} ~ ${FULL_STAMP} then ${x}::timestamptz at time zone 'UTC' end)`;

// The age bands of the hivvl and tbgnx copy tables (HIVVL lines 56-70, sp_getTBsLastHour lines 35-49):
// '<01', '01-04', ... '45-49', '50+'. Not the dbo.Agegroup of the other reports (ageGroupSql). A negative or
// missing age gives NULL.
export const copyAgeGroupSql = (yearsExpr) => {
  const a = `(${yearsExpr})`;
  return `case
      when ${a} = 0 then '<01'
      when ${a} between 1 and 4 then '01-04'
      when ${a} between 5 and 9 then '05-09'
      when ${a} between 10 and 14 then '10-14'
      when ${a} between 15 and 19 then '15-19'
      when ${a} between 20 and 24 then '20-24'
      when ${a} between 25 and 29 then '25-29'
      when ${a} between 30 and 34 then '30-34'
      when ${a} between 35 and 39 then '35-39'
      when ${a} between 40 and 44 then '40-44'
      when ${a} between 45 and 49 then '45-49'
      when ${a} >= 50 then '50+'
    end`;
};

// ---- Parts shared by the hivvl and eid copy tables ----
// Both rebuild a v1 table that has the same shape: one row per result, the earliest tested date per
// lab id, the same request facts. The builders below call these; each helper returns SQL text.

// The `from`/`to` window of a builder: `prefilter` goes in the source CTE (it keeps every row of the
// lab ids that have a report issued in the window, so the dedupe sees them all; lab ids match as SQL Server compares text, ignoring
// case and trailing spaces) and `finalRange` goes
// after the dedupe. Both are '' without a window. Giving only one of the two throws. `finalDate` is the
// date column `finalRange` tests (a builder with no dedupe passes its own source column). `extraDays` moves
// the end of both windows later (see inRange).
export function copyWindow(who, from, to, finalDate = 'r.tested_date', extraDays = 0) {
  if ((from === undefined) !== (to === undefined)) throw new Error(`${who}: give both from and to, or neither`);
  if (from === undefined) return { prefilter: '', finalRange: '' };
  return {
    prefilter: `and ${foldSql('lr.request_id')} in (select ${foldSql('lr2.request_id')} from lab_requests lr2 join diagnostic_reports dr2 on dr2.based_on_id = lr2.id where ${inRange('dr2.issued', from, to, extraDays)})`,
    finalRange: `and ${inRange(finalDate, from, to, extraDays)}`,
  };
}

// The source rows: a request with a result and a report. `columns` are the builder's own select items
// (no trailing comma); `where` is its filter. The mapped requesting facility is required (v1
// inner-joins its dictionary).
export const reportSourceSql = ({ columns, where, prefilter }) => `select lr.id as request_row_id, dr.id as report_row_id, l.id as result_row_id, lr.request_id as lab_id,
      fmr.region as province, fmr.district as district, fmr.name as facility, p.sex,
      dr.issued as tested_date, lr.analysis_at as run_date, s.received_time as received_date,
      lr.authored_at as registered_date, dr.effective as collected_date,
      dr.performer as testing_code, null::text as receiving_code,
      ${columns}
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    ${requesterJoin('lr', 'fmr')}
    join diagnostic_reports dr on dr.based_on_id = lr.id
    left join specimens s on s.id = dr.specimen_id
    left join patients p on p.id = lr.patient_id
    where ${where}
      ${prefilter}`;

// The dedupe order (sp_remove_dupsHIVVLEID): earliest tested date per lab id, NULL first as SQL Server sorts.
// Ties go to the request, report and result row ids; v1 keeps either one. `seq = 1` is the kept row.
// v1 partitions on RequestID in its Latin1_General_CI_AS collation, so lab ids that differ only in case or trailing spaces are one lab id
// ('ABC123' and 'abc123 '): the partition is on the folded id, and the kept row keeps its own spelling.
export const rankedSql = (srcName) => `select s.*, row_number() over (partition by ${foldSql('s.lab_id')} order by ${localTs('s.tested_date')} nulls first, s.request_row_id, s.report_row_id, s.result_row_id) as seq
    from ${srcName} s`;

// v1's gender case of the copy tables: F, M, I and U only; everything else is NULL.
export const genderFmiuSql = (sexExpr) => `case upper(rtrim(${sexExpr})) when 'F' then 'Female' when 'M' then 'Male' when 'I' then 'Indeterminate' when 'U' then 'Unknown' end`;

// The text value of one request attribute (spec section 3) of the request row `rowIdExpr`; NULL when absent.
export const requestAttrSql = (rowIdExpr, code) => `(select max(a.value_text) from lab_request_attributes a where a.lab_request_id = ${rowIdExpr} and a.system = ${sqlLit(ATTR_SYSTEM)} and a.code = ${sqlLit(code)})`;

// TestedAt: a 3-character ZU code other than ZUE and ZUA becomes ZUL. SQL Server LIKE ignores trailing
// blanks in the matched text, so 'ZUB ' also becomes ZUL (the port trims first). `baseExpr` is the testing
// code, or the receiving code when the testing code is blank (see rowFactsSql).
export const testedAtSql = (baseExpr, testingExpr) => `case when rtrim(${baseExpr}) ilike 'ZU_' and ${foldSql(testingExpr)} not in ('zue', 'zua') then 'ZUL' else ${baseExpr} end`;

// Referral: 1 when a receiving code differs from the testing code, else 0. NULL while the receiving code is
// not carried (ruling 7); it is never coalesced to 0.
export const referralSql = (receivingExpr, testingExpr) => `case
      when ${receivingExpr} is null then null::int
      when length(rtrim(${receivingExpr})) > 0 and ${foldSql(receivingExpr)} <> ${foldSql(testingExpr)} then 1
      else 0
    end`;

// Disalink: a pre-registration facility code, or a referring request id that starts with a known
// 5-character facility code that is not a number. `digitPrefix` adds hivvl's third term: a referring id
// whose first 3 characters are numeric (HIVVL line 82; EID line 41 has no such term).
export const disalinkSql = (preregExpr, referringExpr, { digitPrefix = false } = {}) => `case
      when length(rtrim(${preregExpr})) > 0 then 1
      when exists (select 1 from facility_map fd where fd.registry_id is not null and ${foldSql('fd.source_code')} = ${foldSql(`left(${referringExpr}, 5)`)})
        and not ${isNumericSql(`left(${referringExpr}, 5)`)} then 1${digitPrefix ? `
      when ${isNumericSql(`left(${referringExpr}, 3)`)} then 1` : ''}
      else 0
    end`;

// v1 datediff(hh, a, b): the hour boundaries between two stamps, not elapsed hours (09:59 to 10:01 is 1).
// NULL when either is not a full stamp. The offsets are fixed whole hours, so UTC hours give v1's answer.
export const hoursBetweenSql = (fromExpr, toExpr) => `extract(epoch from date_trunc('hour', ${utcTs(toExpr)}) - date_trunc('hour', ${utcTs(fromExpr)})) / 3600`;

// The per-row facts both builders need, as select items for a lateral subquery over the ranked rows `r`
// (columns tested_date, collected_date, testing_code, receiving_code, lab_id, request_row_id):
//   tat           date boundaries (datediff dd) between the LOCAL collected and tested dates
//   hours_taken   hour boundaries (datediff hh) between them, for poc_w48h
//   is_poc        a numeric testing code, or a lab id whose first 3 characters are numeric, or `pocExtra`
//   base_code     the testing code, else the receiving code when the testing code is blank
//   prereg_facility, referring_id   the two request attributes behind disalink
export const rowFactsSql = (r, pocExtra = 'false') => `${localDate(`${r}.tested_date`)} - ${localDate(`${r}.collected_date`)} as tat,
    ${hoursBetweenSql(`${r}.collected_date`, `${r}.tested_date`)} as hours_taken,
    ${pocExtra} or ${isNumericSql(`${r}.testing_code`)} or ${isNumericSql(`left(${r}.lab_id, 3)`)} as is_poc,
    case when length(rtrim(${r}.testing_code)) = 0 then ${r}.receiving_code else ${r}.testing_code end as base_code,
    ${requestAttrSql(`${r}.request_row_id`, 'prereg-registration-facility')} as prereg_facility,
    ${requestAttrSql(`${r}.request_row_id`, 'referring-request-id')} as referring_id`;

// Zambia's `hivvl` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   hivvlCte('hv')                              all rows
//   hivvlCte('hv', { from: 'from', to: 'to' })  only rows whose tested_date is in the window; the two
//                                               values are parameter names, compared as in inRange
//   hivvlCte('hv', { from, to, extraDays: 1 })  the same, with the end of the window moved later by that many
//                                               days (sp_dash_getHIVVL_v2 reads up to the day after its end date)
//   hivvlCte('hv', { from, to, labsInWindow: true })  one row for every lab id that has a report in the window, whatever
//                                               the kept row's tested_date (for a report that joins the table by lab id,
//                                               as sp_getUniqueVLClientsInfo does; a lab whose earliest row is before the
//                                               window still has its row, as in v1's full table)
// v1 fills the table with sp_update_HIVVLTable (a MERGE that also deletes rows missing from its source)
// and then sp_remove_dupsHIVVLEID. The CTE returns what the table holds after both.
//
// Columns, in the order of Table__dbo_HIVVL.sql:
//   province, district, facility, lab_id, gender, age_group, tested_date, suppressed, uu, tat,
//   tat_within14, pregnant, breastfeeding, baseline_vl, run_date, received_date, registered_date,
//   collected_date, tested_at, referral, disalink, three_m_post_unsuppressed, poc, poc_w48h
// The five dates are CE's ISO text (tested_date = diagnostic_reports.issued, run_date =
// lab_requests.analysis_at, received_date = specimens.received_time, registered_date =
// lab_requests.authored_at, collected_date = diagnostic_reports.effective).
//
// One row per final result: a request row (lab_requests) with a result row (lab_results) in panel
// HIVVL, POCVR or POHVL and observation HIVVL, HIVVC, HIVTM, HIVVD, POCVR or POCVC, whose report is
// final and whose result is on the valid list or is a number (v1 lines 120-133). The requesting
// facility must be mapped to a ZMFAC register row, as v1 inner-joins its dictionary (line 109).
//
// The dedupe keeps one row per lab id, the earliest tested_date (sp_remove_dupsHIVVLEID). v1 sorts
// NULL first, so a row with no tested date wins. Ties are broken on the request row id, the report row id, then the
// result row id; v1 keeps either one. The dedupe runs over all rows of the lab id before the window,
// so a lab id whose earliest row is outside the window shows nothing in it.
//
// Kept v1 quirks (spec ruling 1):
//   - age_group has its own labels: '<01', '01-04', '05-09', ... '45-49', '50+' (lines 56-70). A
//     negative or missing age gives NULL. It is not the dbo.Agegroup of the other reports.
//   - gender knows only F, M, I and U; everything else, including N and O, is NULL (lines 49-55).
//   - pregnant, breastfeeding, baseline_vl and three_m_post_unsuppressed are 1 or NULL, never 0
//     (lines 30-44: a left join to the rows where the flag is 1).
//   - suppressed counts any number under 1000, and a text only when it is on the list (line 87).
//     v1 reads the number (SIValue; here numeric_value) apart from the text, and so does the port. A result
//     held only as text ('5,000', '120') passes the valid-result filter (ISNUMERIC on the text) and has
//     no numeric value, so it is neither suppressed nor UU. This is not a v1 defect; it is what the
//     checks show. UU is a number under 200 or a not-detected text (line 95).
//   - tat counts date boundaries of the LOCAL dates (datediff dd), each date taken from the stamp's own
//     text, not shifted to UTC. tat_within14 is 0, not NULL, when tat is NULL.
//     poc_w48h counts hour boundaries (datediff hh) and tests 24, although its name says 48.
//   - The valid list holds 'PTLTT' where the suppressed list holds 'PLTT'. DET, PLTT and
//     '<883 copies/mL' are suppressed texts that never pass the valid-result filter.
//   - ISNUMERIC counts '1E5' and '12' as numbers: a lab id like '1E5-X' or a testing code like '12' is POC.
//   - tested_at: a 3-character ZU code other than ZUE and ZUA becomes ZUL (lines 76-79). SQL Server
//     LIKE ignores trailing blanks in the matched text, so 'ZUB ' also becomes ZUL (the port trims first).
//   - Partial stamps ('2026-07') give NULL dates and TAT, and never raise. A date-only stamp gives its date.
//
// CE gaps:
//   - ReceivingFacilityCode is not carried (ruling 7). receiving_code is a NULL column in the first
//     CTE, so the v1 expressions keep their form. tested_at uses only the testing code (the
//     performer). referral is NULL; when a receiving code arrives it follows line 80 (1 or 0).
//   - Disalink reads the request attributes prereg-registration-facility (LIMSPreReg_RegistrationFacilityCode)
//     and referring-request-id (ReferringRequestID). cdr-toolchain does not fill them yet, so disalink
//     is 0 until it does. v1's facility list is the mapped facility_map codes.
//   - The VIRAL answers come from questionnaire_responses (ruling 6), not LabResults. The form keeps the
//     reported text, so v1's coded-value test (LIMSCodedValue = 'BASE', line 22) is covered by the text
//     test (ARTRS text like '%Base%') only. A form on any request row of the lab id counts, because v1
//     keys the flags on RequestID. RTRI is a lab panel: any result row on an RTRI request is a baseline test.
export function hivvlCte(name, { from, to, extraDays = 0, labsInWindow = false } = {}) {
  const { prefilter, finalRange: windowed } = copyWindow('hivvlCte', from, to, 'r.tested_date', extraDays);
  const finalRange = labsInWindow ? '' : windowed;
  const result = rpt('l');
  return `${name} as (
  with ${name}_src as (
    ${reportSourceSql({
      columns: `lr.age_years, ${result} as result_text, l.numeric_value`,
      where: `${inListSql('lr.panel_code', ['HIVVL', 'POCVR', 'POHVL'])}
      and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC', 'HIVTM', 'HIVVD', 'POCVR', 'POCVC'])}
      and dr.status = 'final'
      and (${inListSql(result, HIVVL_VALID)} or ${isNumericSql(result)})`,
      prefilter,
    })}
  ),
  ${name}_ranked as (
    ${rankedSql(`${name}_src`)}
  ),
  ${name}_flags as (
    select ${foldSql('q.request_id')} as lab_key,
      max(case when ${inListSql('a.vpreg', YES_WORDS)} or ${inListSql('a.artpr', YES_WORDS)} or ${inListSql('a.artrs', ['Pregnant Mother'])} then 1 end) as pregnant,
      max(case when ${inListSql('a.vbrea', YES_WORDS)} or ${inListSql('a.artbr', YES_WORDS)} or ${inListSql('a.artrs', ['Lactating Mother'])} then 1 end) as breastfeeding,
      max(case when a.artrs ilike '%Base%' or (q.panel_code = 'RTRI' and exists (select 1 from lab_results x where x.request_id = q.id)) then 1 end) as baseline_vl,
      max(case when ${inListSql('a.visit', ['3 months post unsuppressed VL result'])} or ${inListSql('a.artrs', ['Confirmation of Treatment Failure (repeat VL at 3M)', 'Post EAC'])} then 1 end) as three_m_post_unsuppressed
    from lab_requests q
    cross join lateral (select
      ${formAnswerSql('q.id', 'ARTPR')} as artpr, ${formAnswerSql('q.id', 'VPREG')} as vpreg,
      ${formAnswerSql('q.id', 'ARTBR')} as artbr, ${formAnswerSql('q.id', 'VBREA')} as vbrea,
      ${formAnswerSql('q.id', 'ARTRS')} as artrs, ${formAnswerSql('q.id', 'VISIT')} as visit) a
    where ${foldSql('q.request_id')} in (select ${foldSql('s.lab_id')} from ${name}_src s)
    group by ${foldSql('q.request_id')}
  )
  select r.province, r.district, r.facility, r.lab_id,
    ${genderFmiuSql('r.sex')} as gender,
    ${copyAgeGroupSql('r.age_years')} as age_group,
    r.tested_date,
    case when (${inListSql('r.result_text', HIVVL_SUPPRESSED)} or (r.numeric_value < 1000 and r.result_text not like '>%')) then 1 else 0 end as suppressed,
    case when (${inListSql('r.result_text', HIVVL_UU)} or r.numeric_value < 200) then 1 else 0 end as uu,
    c.tat,
    case when c.tat <= 14 then 1 else 0 end as tat_within14,
    f.pregnant, f.breastfeeding, f.baseline_vl,
    r.run_date, r.received_date, r.registered_date, r.collected_date,
    ${testedAtSql('c.base_code', 'r.testing_code')} as tested_at,
    ${referralSql('r.receiving_code', 'r.testing_code')} as referral,
    ${disalinkSql('c.prereg_facility', 'c.referring_id', { digitPrefix: true })} as disalink,
    f.three_m_post_unsuppressed,
    case when c.is_poc then 1 else 0 end as poc,
    case when c.is_poc and c.hours_taken <= 24 then 1 else 0 end as poc_w48h
  from ${name}_ranked r
  left join ${name}_flags f on f.lab_key = ${foldSql('r.lab_id')}
  cross join lateral (select
    ${rowFactsSql('r')}) c
  where r.seq = 1
    ${finalRange}
)`;
}

// ---- The TND copy table (spec ruling 5) ----

// v1 sp_GetPreviousVLResultforCohort2x (the procedure that fills TND): its panels (line 74), observations (line 74), the 26 texts a
// result must not be (lines 77-104), the 16 suppressed texts (line 52) and the 6 undetectable texts (line 61). v1 compares with SQL
// Server's default collation, so inListSql ignores case and trailing spaces.
export const TND_PANELS = ['HIVVL', 'RTRI'];
export const TND_OBSERVATIONS = ['HIVVL', 'HIVVC', 'HIVTM', 'HIVVD', 'POCVR', 'POCVC'];
export const TND_INVALID_RESULTS = [
  'antibodies. @mat3', 'FAIL', 'Haemolysed', 'Haemolysed ++', 'Insufficient for further tests',
  'Insufficient serum received', 'INV', 'INVAL', 'Negative', 'No', 'Please repeat', 'Positive',
  'to confirm patient identity.', 'Weak Positive', 'Invalid', 'Absent', 'antibodies.', 'AT', 'Failed',
  'Icteric ++++', 'Indeterminate', 'per request', 'Positive (Repeat sample)',
  'This result has been checked', 'VAL', '@con1 @con2',
];
export const TND_SUPPRESSED_RESULTS = [
  '<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml',
  '<30 copies/mL', 'NDET', 'ND', '<20CP', '< 40', '<40 copies/mL', '<400 copies/mL', '<400',
  '<883 copies/mL',
];
export const TND_UU_RESULTS = ['TAR', 'Target Not Detected', 'TARG', 'RNA not detected', 'NDET', 'ND'];

// Zambia's `TND` copy table, rebuilt as CTEs. Put the returned text in a `with` list: it holds three items,
// `<name>_ids`, `<reqName>` and `<name>`. (The first is the ART number's two request attributes, see zmIdsCte.)
//   tndCte('tn')                           from `{{param.from}}` to `{{param.to}}`
//   tndCte('tn', { from: 'a', to: 'b' })   the window parameters, compared as in inRange
// v1 fills TND with sp_GetPreviousVLResultforCohort2x. This is slice 1's part 1 ("VL clients by province") and Task 11's source.
//
// `<reqName>` (default `<name>_req`) is the request rows: one row per request that has a panel in the TND panels (or in `extraPanels`)
// and a report, with the mapped requesting facility. Slice 1's parts 2 and 3 read it for the cancelled and unclear requests, which TND
// does not hold. Columns: id, request_id, panel_code, age_years, authored_at, province, district, facility, client_name (first name, a
// space, surname), firstname, surname, sex, gender (slice 1's word: F, M, U, I, else Missing), reference_numbers, unique_id,
// report_status, collected_date, result_date.
// `<name>` is the TND rows, one row per result row (v1 TND has one row per LabResults row). Columns: province, district, facility,
// lab_id, client_name, firstname, surname, age_years, sex, gender, art_number, collected_date, registered_date, result_date, result,
// suppressed_flag, uu_flag. The two flags are v1's TND.Suppressed and TND.UU (1 or 0).
//
// What it takes from v1 (line numbers of StoredProcedure__dbo_sp_GetPreviousVLResultforCohort2x.sql):
//   - Province, District, Facility are the mapped ZMFAC row of the requesting facility (lines 67-72); an unmapped facility drops out.
//   - ART number: artNumberSql (lines 40-48), HOSPID not sent. FIRSTNAME and SURNAME and the sex code are the patient's (left join: a
//     request without a patient row keeps empty names and a NULL sex, where v1 inner-joins Patients).
//   - ResultDate is the report's issued stamp (AuthorisedDateTime), Result is rpt() (LIMSRptResult). The report is final (line 76).
//   - Suppressed (lines 49-60): a suppressed text, or a number under 1000. UU (line 61): an undetectable text, or a number under 200.
//     The comparison is of the number alone: a comparator ('<') is not read.
//   - A result of NULL is out (NOT IN drops NULL, line 77).
//
// Not taken by default: the Rank column (TND.Rank, the visit number; `rank: true` below adds it), BaselineVL (callers use the hivvl copy's),
// and the floor and ceiling of line 105 (AuthorisedDateTime from 2017-01-01 to now): the window is the caller's. `rank: true` applies them.
// The window of this builder is a LOCAL-DATE window, from the first to the last day inclusive (inRange). A report that compares the
// datetime of ResultDate with dates (a window that ends at 00:00:00 of the last day) filters again on the result's own time.
// Options: `where` is a condition on the mapped row `fmr` and the request `lr`, applied while reading requests (slice 1's province
// parameter); `extraPanels` and `orRegistered` widen the request rows for slice 1's parts 2 and 3 (a request registered in the window
// without a report in it, and the panel HIVVL).
// `rank: true` is v1's TND.Rank (the visit number): it reads EVERY result of the clients, with no window (`from` and `to` are not used;
// the caller applies its own), and adds three columns to the TND rows: `panel_code`, `result_row_id` (the lab_results row) and `visit`.
// v1 numbers a client's results with row_number() over the province, district, facility, panel, sex code, surname, first name and ART
// number (compared as SQL Server compares text), newest ResultDate first (lines 20-30), so visit 1 is the client's latest result EVER,
// whatever window a report asks. The partition has the panel and the sex code, so a client with a result in each of two panels (or
// with two sex codes) has a visit 1 in each. Ties on the stamp are broken on the lab number, then the result row (v1 picks any). A
// row without a date (no report stamp, or a partial one such as '2026-07') is out, as v1's BETWEEN drops a NULL date. v1's own floor and
// ceiling apply (line 105: AuthorisedDateTime between 2017-01-01 00:00:00 and getdate()): a report on a local date before 2017-01-01, or
// stamped after now, is out, so a future-dated result never becomes a client's newest. The ceiling compares INSTANTS (the stamp carries its
// offset, utcTs against now() in UTC), so it does not depend on the server's time zone; a date-only stamp has no offset and falls back to its
// midnight against localtimestamp. The default
// (`rank` false) is unchanged, so slice 1 and every other caller read the same rows as before. `rank` cannot be used with `orRegistered`.
export function tndCte(name, { from = 'from', to = 'to', reqName = `${name}_req`, where = 'true', extraPanels = [], orRegistered = false, rank = false } = {}) {
  if (rank && orRegistered) throw new Error('tndCte: rank cannot be used with orRegistered');
  const idsName = `${name}_ids`;
  const result = rpt('r');
  const requestWindow = rank ? `${localDate('dr.issued')} >= date '2017-01-01' and coalesce(${utcTs('dr.issued')} <= now() at time zone 'UTC', ${localTs('dr.issued')} <= localtimestamp)` : `${inRange('dr.issued', from, to)}${orRegistered ? ` or ${inRange('lr.authored_at', from, to)}` : ''}`;
  const resultWindow = rank ? '' : `
    and ${inRange('q.result_date', from, to)}`;
  const columns = `q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.firstname, q.surname, q.age_years, q.sex, q.gender,
    ${artNumberSql("coalesce(q.reference_numbers, '')", "coalesce(q.unique_id, '')")} as art_number,
    q.collected_date, q.authored_at as registered_date, q.result_date,
    ${result} as result,
    case when ${inListSql(result, TND_SUPPRESSED_RESULTS)} or r.numeric_value < 1000 then 1 else 0 end as suppressed_flag,
    case when ${inListSql(result, TND_UU_RESULTS)} or r.numeric_value < 200 then 1 else 0 end as uu_flag`;
  const rows = `from ${reqName} q
  join lab_results r on r.request_id = q.id
  where q.panel_code in (${sqlList(TND_PANELS)})
    and r.observation_code in (${sqlList(TND_OBSERVATIONS)})
    and q.report_status = 'final'${resultWindow}
    and ${result} is not null
    and not ${inListSql(result, TND_INVALID_RESULTS)}`;
  const visitPartition = ['b.province', 'b.district', 'b.facility', 'b.panel_code', 'b.sex', 'b.surname', 'b.firstname', 'b.art_number'].map(foldSql).join(', ');
  const tndRows = rank
    ? `select b.*, row_number() over (partition by ${visitPartition} order by ${localTs('b.result_date')} desc, b.lab_id, b.result_row_id) as visit
  from (select ${columns}, q.panel_code, r.id as result_row_id
  ${rows}) b`
    : `select ${columns}
  ${rows}`;
  return `${zmIdsCte(idsName)},
${reqName} as (
  select lr.id, lr.request_id, lr.panel_code, lr.age_years, lr.authored_at,
    fmr.region as province, fmr.district, fmr.name as facility,
    concat(p.firstname, ' ', p.surname) as client_name, p.firstname, p.surname, p.sex,
    case p.sex when 'F' then 'Female' when 'M' then 'Male' when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Missing' end as gender,
    zi.reference_numbers, zi.unique_id,
    dr.status as report_status, dr.effective as collected_date, dr.issued as result_date
  from lab_requests lr
  ${requesterJoin('lr', 'fmr')}
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  left join patients p on p.id = lr.patient_id
  left join ${idsName} zi on zi.lab_request_id = lr.id
  where ${where}
    and lr.panel_code in (${sqlList([...new Set([...TND_PANELS, ...extraPanels])])})
    and (${requestWindow})
),
${name} as (
  ${tndRows}
)`;
}

// ---- The eid copy table ----

// v1 sp_update_EIDTable: the five result lists (lines 45, 51, 57, 63, 69). Compared as in hivvl.
const EID_POSITIVE = ['Positive', 'Positive*', 'POS', 'Detected DBS', 'Detected', 'DET'];
const EID_NEGATIVE = ['LDL', 'NDET', 'Negative*', 'Not Detected', 'Not Detected DBS', 'Negative', 'NDDB', 'NDT', 'NDTD'];
const EID_INVALID = ['Invalid', 'VALID'];
const EID_ERROR = ['Error'];
const EID_INDETERMINATE = ['Indeterminate', 'NORES'];

// Zambia's `eid` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   eidCte('ed')                              all rows
//   eidCte('ed', { from: 'from', to: 'to' })  only rows whose tested_date is in the window; the two
//                                             values are parameter names, compared as in inRange
//   eidCte('ed', { from, to, extraDays: 1 })  the same, with the end of the window moved later by that many
//                                             days (sp_dash_getEID_V2 and sp_dash_getEID_v2_List read up to
//                                             the day after their end date)
//   eidCte('ed', { rowIds: true })            adds request_row_id and report_row_id as the last two columns: the
//                                             lab_requests and diagnostic_reports rows of the row the dedupe kept
//                                             (for a report that needs the kept row's patient, attributes or
//                                             report, as "EID clients by province" does). The default columns are
//                                             unchanged.
// v1 fills the table with sp_update_EIDTable (a MERGE that also deletes rows missing from its source)
// and then the eid half of sp_remove_dupsHIVVLEID. The CTE returns what the table holds after both.
//
// Columns, in the order of Table__dbo_EID.sql (v1 spells the fourth date "RecievedDate"; kept):
//   province, district, facility, lab_id, gender, age_group, tested_date, positive, tat, tat_within14,
//   run_date, recieved_date, registered_date, collected_date, tested_at, referral, disalink, error,
//   invalid, negative, indeterminate, poc, poc_w48h
// The five dates are CE's ISO text (tested_date = diagnostic_reports.issued, run_date =
// lab_requests.analysis_at, recieved_date = specimens.received_time, registered_date =
// lab_requests.authored_at, collected_date = diagnostic_reports.effective).
//
// One row per final result: a request row (lab_requests) with a result row (lab_results) in panel
// HIVPC, POCGH or POEID and observation HIVPC, HIVPR or PGHIV, whose report is final (v1 lines
// 91-93). There is no filter on the result itself, unlike hivvl. The requesting facility must be
// mapped to a ZMFAC register row, as v1 inner-joins its dictionary (lines 82-87). Panel, observation
// and the result lists compare ignoring case and trailing spaces, as SQL Server does.
//
// The dedupe keeps one row per lab id, the earliest tested_date (sp_remove_dupsHIVVLEID lines 33-44).
// v1 sorts NULL first, so a row with no tested date wins. Ties are broken on the request row id, the
// report row id, then the result row id; v1 keeps either one. The dedupe runs over all rows of the lab
// id before the window, so a lab id whose earliest row is outside the window shows nothing in it.
// (v1's MERGE ranks rows by a constant, line 10, and only the rank 1 row matches the table, line 95.
// The other rows are inserted as new rows, so the table holds every source row until the dedupe runs.)
//
// Rules, with v1 lines:
//   - gender: F, M, I, U; anything else is NULL (lines 12-18).
//   - age_group: bands of lab_requests.age_days, 0-6 'At Birth' up to 750 and over '> 2 years'; a
//     negative or missing age is NULL (lines 19-29).
//   - positive, negative, invalid, error, indeterminate: 1 when the result text (rpt) is on the list
//     of that class, else 0 (lines 43-72). A number or a text on no list sets none.
//   - tat: datediff(dd) from collected to tested; tat_within14 is 1 when tat <= 14, else 0 (lines 73-74).
//   - tested_at: the testing code, a 3-character ZU code other than ZUE and ZUA becomes ZUL (lines 35-38).
//   - disalink: 1 when a pre-registration facility code is present, or the referring request id starts
//     with a known 5-character facility code that is not a number (lines 41-42).
//   - poc: observation PGHIV on the result row, or a numeric testing code, or a lab id whose first 3
//     characters are numeric (line 75). poc_w48h: poc and datediff(hh) from collected to tested <= 24 (line 76).
//
// Kept v1 quirks (spec ruling 1):
//   - invalid lists 'VALID', not 'INVAL' (line 57); 'INVAL' sets no class.
//   - poc_w48h tests 24 hours, although its name says 48, and counts hour boundaries, not elapsed time.
//   - tat counts date boundaries of the LOCAL dates, each date taken from the stamp's own text, not
//     shifted to UTC. tat_within14 is 0, not NULL, when tat is NULL.
//   - ISNUMERIC counts '1E5' and '12' as numbers: a lab id like '1E5-X' or a testing code like '12' is POC.
//   - disalink does not count a referring id that starts with digits; HIVVL's does (HIVVL line 82; EID line 41 has no such term).
//   - tested_at: SQL Server LIKE ignores trailing blanks in the matched text, so 'ZUB ' also becomes ZUL.
//   - Partial stamps ('2026-07') give NULL TAT and never raise. A date-only stamp gives its date.
//   - v1's table has narrow columns (lab_id 26, tested_at 10, facility 50); a longer value would stop v1's
//     insert. The port does not cut.
//
// CE gaps:
//   - ReceivingFacilityCode is not carried (ruling 7). receiving_code is a NULL column in the first CTE, so
//     the v1 expressions keep their form. tested_at uses only the testing code (the performer). referral is
//     NULL (v1 gives 0 for a blank code, line 40); when a receiving code arrives it follows line 39 (1 or 0).
//   - Disalink reads the request attributes prereg-registration-facility (LIMSPreReg_RegistrationFacilityCode)
//     and referring-request-id (ReferringRequestID). cdr-toolchain does not fill them yet, so disalink is 0
//     until it does. v1's facility list is the mapped facility_map codes.
export function eidCte(name, { from, to, extraDays = 0, rowIds = false } = {}) {
  const { prefilter, finalRange } = copyWindow('eidCte', from, to, 'r.tested_date', extraDays);
  const flag = (words) => `case when ${inListSql('r.result_text', words)} then 1 else 0 end`;
  return `${name} as (
  with ${name}_src as (
    ${reportSourceSql({
      columns: `lr.age_days, l.observation_code as obs_code, ${rpt('l')} as result_text`,
      where: `${inListSql('lr.panel_code', ['HIVPC', 'POCGH', 'POEID'])}
      and ${inListSql('l.observation_code', ['HIVPC', 'HIVPR', 'PGHIV'])}
      and dr.status = 'final'`,
      prefilter,
    })}
  ),
  ${name}_ranked as (
    ${rankedSql(`${name}_src`)}
  )
  select r.province, r.district, r.facility, r.lab_id,
    ${genderFmiuSql('r.sex')} as gender,
    case
      when r.age_days between 0 and 6 then 'At Birth'
      when r.age_days between 7 and 48 then '1 - 6 Weeks'
      when r.age_days between 49 and 209 then '7 weeks to 6 Months'
      when r.age_days between 210 and 299 then '7 - 9 Months'
      when r.age_days between 300 and 389 then '10 - 12 Months'
      when r.age_days between 390 and 569 then '13 - 18 Months'
      when r.age_days between 570 and 749 then '19 - 24 Months'
      when r.age_days >= 750 then '> 2 years'
    end as age_group,
    r.tested_date,
    ${flag(EID_POSITIVE)} as positive,
    c.tat,
    case when c.tat <= 14 then 1 else 0 end as tat_within14,
    r.run_date, r.received_date as recieved_date, r.registered_date, r.collected_date,
    ${testedAtSql('c.base_code', 'r.testing_code')} as tested_at,
    ${referralSql('r.receiving_code', 'r.testing_code')} as referral,
    ${disalinkSql('c.prereg_facility', 'c.referring_id')} as disalink,
    ${flag(EID_ERROR)} as error,
    ${flag(EID_INVALID)} as invalid,
    ${flag(EID_NEGATIVE)} as negative,
    ${flag(EID_INDETERMINATE)} as indeterminate,
    case when c.is_poc then 1 else 0 end as poc,
    case when c.is_poc and c.hours_taken <= 24 then 1 else 0 end as poc_w48h${rowIds ? ',\n    r.request_row_id, r.report_row_id' : ''}
  from ${name}_ranked r
  cross join lateral (select
    ${rowFactsSql('r', `${foldSql('r.obs_code')} = 'pghiv'`)}) c
  where r.seq = 1
    ${finalRange}
)`;
}

// ---- The tbgnx copy table and its view v_GeneXpert ----

// The two panels of a GeneXpert test (view lines 46 and 73).
const GX_PANELS = ['TBGNX', 'POCGT'];

// sp_getTBsLastHour lines 51-70: the MTB and RIF clean-up. Each class is [label, words]; a text on no list
// stays as reported. v1 compares with SQL Server's default collation, so inListSql ignores case and
// trailing spaces.
const MTB_CLASSES = [
  ['MTB Not Detected', ['Not Detected', 'Negative']],
  ['MTB Detected', ['Detected', 'Positive', 'Detected _ Medium', 'Detected _ Very Low', 'Detected _ High', 'Detected _ Low']],
  ['No Results', ['NORES']],
];
const RIF_CLASSES = [
  ['Detected', ['DETEC', 'Detected', 'Detected _ Medium', 'Detected _ High', 'Positive', 'Resistant', 'MTB Detected', 'R']],
  ['Not Detected', ['MTB Not Detected', 'NDET', 'Negative', 'S', 'Sensitive', 'Susceptible', 'Not Detected']],
  ['Error', ['Error', 'ERR']],
  ['Indeterminate', ['IND', 'Indeterminate', 'RIF Resistance INDETERMINATE', 'Intermediate']],
  ['Invalid', ['INV', 'Invalid']],
  ['No Results', ['NORES']],
];
const classSql = (expr, classes) => `case ${classes.map(([label, words]) => `when ${inListSql(expr, words)} then ${sqlLit(label)}`).join(' ')} else ${expr} end`;

// ReceivingFacilityCode is not carried (ruling 7). The view takes it when the testing code is blank
// (view lines 26-29), so a blank testing code gives NULL here.
const NO_RECEIVING_CODE = 'null::text';

// One result row of a GeneXpert request (view lines 20-46 and 48-73): the request facts of x and y.
// `resultAlias` names the result column, `obsCode` picks the observation. A request without a report, a
// specimen or a patient still shows, with those columns empty (v1 reads Requests alone). The facility is
// left-joined: an unmapped facility gives no description, province or district, as v1's left join does.
const gxSourceSql = (obsCode, resultAlias, finalRange) => `select lr.request_id as requestid, lr.requester_code as lims_facility_code, fmr.name as description,
      case when rtrim(dr.performer) = '' then ${NO_RECEIVING_CODE} else dr.performer end as tested_at,
      dr.effective as specimen_date_time, lr.authored_at as registered_date_time, s.received_time as received_date_time,
      lr.analysis_at as analysis_date_time, dr.issued as authorised_date_time, p.sex as hl7_sex_code,
      lr.age_years as age_in_years, lr.age_days as agein_days, ${rpt('l')} as ${resultAlias}, lr.panel_code as lims_panel_code,
      fmr.region as province, fmr.district as district, ${labNameSql('dr')} as lab_name
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    ${requesterJoin('lr', 'fmr', 'left join')}
    left join diagnostic_reports dr on dr.based_on_id = lr.id
    left join specimens s on s.id = dr.specimen_id
    left join patients p on p.id = lr.patient_id
    where ${inListSql('lr.panel_code', GX_PANELS)} and ${inListSql('l.observation_code', [obsCode])}
      ${finalRange}`;

// The with-list shared by both builders: the view's rows (x joined to y, a, b and id) with the extra
// columns province, district and lab_name that the table needs. `<name>_rows` is the last item.
function geneXpertRows(who, name, from, to, on = 'issued') {
  if (on !== 'issued' && on !== 'analysis_at') throw new Error(`${who}: on must be 'issued' or 'analysis_at'`);
  const { finalRange } = copyWindow(who, from, to, on === 'issued' ? 'dr.issued' : 'lr.analysis_at');
  // View lines 107-120: a GXRIF row joins a GXMTB row when the request number and eleven request facts are
  // equal. Text compares ignore case and trailing spaces. A NULL fact equals nothing, so the RIF is lost.
  const sameText = (c) => `${foldSql(`x.${c}`)} = ${foldSql(`y.${c}`)}`;
  const sameValue = (c) => `x.${c} = y.${c}`;
  return `${name}_x as (
    ${gxSourceSql('GXMTB', 'mtb', finalRange)}
  ),
  ${name}_y as (
    ${gxSourceSql('GXRIF', 'rif', finalRange)}
  ),
  ${name}_tbcol as (
    select lr.request_id as requestid, ${foldSql('l.observation_code')} as obs, ${rpt('l')} as answer
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    where ${inListSql('lr.panel_code', ['TBCOL'])} and ${inListSql('l.observation_code', ['TBHIV', 'TBAGE', 'PADIS'])}
      and lr.request_id in (select s.requestid from ${name}_x s)
  ),
  ${name}_rows as (
    select id.answer as dist_tb_number, x.requestid, x.lims_facility_code, x.description, x.tested_at,
      x.specimen_date_time, x.registered_date_time, x.received_date_time, x.analysis_date_time,
      x.authorised_date_time, x.hl7_sex_code, x.age_in_years, x.agein_days, x.mtb, x.lims_panel_code,
      y.rif, a.answer as tbhiv, b.answer as tbage, x.province, x.district, x.lab_name
    from ${name}_x x
    left join ${name}_y y on x.requestid = y.requestid
      and ${sameText('lims_facility_code')}
      and ${sameText('description')}
      and ${sameText('tested_at')}
      and ${sameValue('specimen_date_time')}
      and ${sameValue('registered_date_time')}
      and ${sameValue('received_date_time')}
      and ${sameValue('analysis_date_time')}
      and ${sameValue('authorised_date_time')}
      and ${sameText('hl7_sex_code')}
      and ${sameValue('age_in_years')}
      and ${sameValue('agein_days')}
    left join ${name}_tbcol a on a.requestid = x.requestid and a.obs = 'tbhiv'
    left join ${name}_tbcol b on b.requestid = x.requestid and b.obs = 'tbage'
    left join ${name}_tbcol id on id.requestid = x.requestid and id.obs = 'padis'
  )`;
}

// Zambia's view v_GeneXpert, as a CTE: `<name> as (...)`. Put it in a `with` list.
//   geneXpertCte('gx')                                      all rows
//   geneXpertCte('gx', { from: 'from', to: 'to' })          only rows whose authorised date is in the window
//   geneXpertCte('gx', { from, to, on: 'analysis_at' })     the window is on the analysis date instead
//   geneXpertCte('gx', { labName: true })                   adds lab_name as a last column
// `from` and `to` are parameter names, compared as in inRange (the local date of the stamp). `on` picks the
// window column: 'issued' (the default, AuthorisedDateTime) or 'analysis_at' (AnalysisDateTime). `labName`
// is an addition beyond the view: the view has no LabName, but fn_GeneXpertReport joins it (ruling 8: the
// report's display, else the mapped register name, else the performer's code). It is off by default, so the
// view's columns stay exact.
// The view has no window in v1; the window only limits the rows read. Each consumer applies its own v1
// edges on top: sp_dash_getTBGNX and sp_dash_getTBGNX_List filter the authorised date, with the end date
// moved one day later (@EDate + 1); sp_dash_getTBLabStats has no authorised-date filter on most of its
// aggregates (a registered-date filter on one of them); fn_GeneXpertReport filters the analysis date
// (line 67). The window here is only a way to read fewer rows.
//
// Columns, in the order of the view (View__dbo_v_GeneXpert.sql: line 106 and x.* from lines 20-39), in
// snake_case. requestid keeps v1's one-word spelling, and v1's "AgeinDays" is agein_days.
//   dist_tb_number, requestid, lims_facility_code, description, tested_at, specimen_date_time,
//   registered_date_time, received_date_time, analysis_date_time, authorised_date_time, hl7_sex_code,
//   age_in_years, agein_days, mtb, lims_panel_code, rif, tbhiv, tbage
// The five date-time columns are CE's ISO text (specimen_date_time = diagnostic_reports.effective,
// registered_date_time = lab_requests.authored_at, received_date_time = specimens.received_time,
// analysis_date_time = lab_requests.analysis_at, authorised_date_time = diagnostic_reports.issued).
// mtb and rif are the results as reported (LIMSRptResult, here rpt()); the clean-up is in tbgnxCte.
//
// Rules, with view lines:
//   - One row per GXMTB result (lines 20-46) of a request in panel TBGNX or POCGT. Panel and observation
//     compare ignoring case and trailing spaces. There is no test on the report status.
//   - requestid is lab_requests.request_id, lims_facility_code is lab_requests.requester_code, and
//     description is the mapped register name (line 25).
//   - tested_at is the testing code, the performer of the request's report (lines 26-29).
//   - rif comes from the GXRIF results of the same two panels (lines 48-73, 107-120): same request number
//     and the same eleven request facts (listed on lines 110-120). The RIF may sit on another request
//     row (the other panel) with equal facts.
//   - dist_tb_number, tbhiv and tbage are the PADIS, TBHIV and TBAGE results of the TBCOL rows of the
//     request number (lines 75-105, 121-126), joined on the request number alone.
//
// Kept v1 quirks (spec ruling 1):
//   - The RIF join compares with plain equality, so a NULL fact on either side loses the RIF while the
//     MTB row stays: a missing received, specimen, registered, analysis or authorised date, a missing sex,
//     age in years or age in days, a missing facility, or a facility with no description. A facility that
//     is not mapped to the register has no description here, as one missing from v1's dictionary has.
//   - There is no dedupe. Two GXMTB results, two GXRIF results or two answers to one TBCOL question on a
//     request number give several rows (every match), and two request rows with equal facts cross-match.
//   - Text compares ignore case and trailing spaces, as SQL Server does; values come through as stored.
//
// The window also cuts the GXRIF rows. That cannot change a match, because the join needs equal authorised
// dates and equal analysis dates.
//
// TBCOL: it is not a documentation panel in Zambia's config (config/zambia.yaml lists only VIRAL), so
// cdr-toolchain sends TBCOL as lab results and the answers are in lab_results, not in a form.
//
// CE gaps:
//   - ReceivingFacilityCode is not carried (ruling 7). v1 takes it as tested_at when the testing code is
//     blank; here tested_at is NULL then, which also loses the RIF (a NULL fact) and drops the row from
//     the table (tbgnxCte).
//   - lims_facility_code is lab_requests.requester_code. v1 reads LimsFacilityCode (the DISA facility),
//     not RequestingFacilityCode; CE keeps one facility code for the request.
//   - A partial stamp ('2026-07') stays as text in the date columns and gives NULL hours in tbgnxCte.
//     v1 cannot hold one.
export function geneXpertCte(name, { from, to, on = 'issued', labName = false } = {}) {
  return `${name} as (
  with ${geneXpertRows('geneXpertCte', name, from, to, on)}
  select r.dist_tb_number, r.requestid, r.lims_facility_code, r.description, r.tested_at,
    r.specimen_date_time, r.registered_date_time, r.received_date_time, r.analysis_date_time,
    r.authorised_date_time, r.hl7_sex_code, r.age_in_years, r.agein_days, r.mtb, r.lims_panel_code,
    r.rif, r.tbhiv, r.tbage${labName ? ', r.lab_name' : ''}
  from ${name}_rows r
)`;
}

// Zambia's `TBGNX` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   tbgnxCte('tb')                              all rows
//   tbgnxCte('tb', { from: 'from', to: 'to' })  only rows whose authorised date is in the window; the two
//                                               values are parameter names, compared as in inRange
// v1 sp_getTBsLastHour drops the table and fills it again from v_GeneXpert on every run. Its name says
// "last hour", but the code reads the whole view. The CTE returns what the table holds after a run.
//
// Columns, in the order of Table__dbo_TBGNX.sql, in snake_case:
//   province, district, requestid, lims_facility_code, description, tested_at, lab_name,
//   specimen_date_time, registered_date_time, received_date_time, analysis_date_time,
//   authorised_date_time, hl7_sex_code, age_in_years, gender, age_group, agein_days, mtb, rif, tbhiv,
//   tbage, dist_tb_number, poc, tat, w24h, w48h, w72h
// These are the view's rows (geneXpertCte) with the changes below. v1 has no dedupe, so a request number
// can appear several times.
//
// Rules, with sp_getTBsLastHour lines:
//   - province, district: the mapped register row's region and district (lines 95-101, left joins: an
//     unmapped facility gives NULL for both and the row stays).
//   - lab_name: ruling 8 (v1 joins its Laboratories dictionary, line 89). The report's display, else the
//     register name of the mapped performer, else the performer's code.
//   - gender: F, M, I, U only; anything else is NULL (lines 28-34).
//   - age_group: '<01', '01-04', ... '45-49', '50+' by age in years; a negative or missing age is NULL
//     (lines 35-49).
//   - mtb: 'Not Detected' and 'Negative' give 'MTB Not Detected'; 'Detected', 'Positive' and the four
//     'Detected _ ...' grades give 'MTB Detected'; 'NORES' gives 'No Results'; anything else stays (lines 51-62).
//   - rif: six lists give 'Detected', 'Not Detected', 'Error', 'Indeterminate', 'Invalid' and 'No Results';
//     anything else stays (lines 63-70).
//   - poc: 1 when the panel is POCGT or tested_at is a number (ISNUMERIC, so '1E5' counts), else 0 (line 76).
//   - tat: datediff(hh) from the specimen date to the authorised date. w24h, w48h and w72h are 1 when tat
//     is under 24, 48 and 72, else 0, also when tat is NULL (lines 77-80).
//   - Rows with tested_at '000' or NULL are dropped (line 102).
//
// Kept v1 quirks (spec ruling 1), besides those of geneXpertCte:
//   - tat counts hour boundaries, not elapsed hours: 09:59 to 10:01 is 1. The flags test "under", so a
//     tat of exactly 24 is not in w24h. A negative tat (authorised before the specimen) is in all three.
//   - A text on no MTB or RIF list stays as reported, in its own case: 'DET' stays 'DET'. 'Detected _ Low'
//     is on the MTB list only, so in rif it stays as it is.
//   - The table's columns are narrow (requestid 26, tested_at 10, mtb 80, and so on); a longer value would
//     stop v1's insert. The port does not cut.
//
// CE gaps: those of geneXpertCte. Also lab_name differs from v1 where Zambia's lab dictionary names a lab
// differently from the report's display or the register (ruling 8).
export function tbgnxCte(name, { from, to } = {}) {
  return `${name} as (
  with ${geneXpertRows('tbgnxCte', name, from, to)}
  select r.province, r.district, r.requestid, r.lims_facility_code, r.description, r.tested_at, r.lab_name,
    r.specimen_date_time, r.registered_date_time, r.received_date_time, r.analysis_date_time,
    r.authorised_date_time, r.hl7_sex_code, r.age_in_years,
    ${genderFmiuSql('r.hl7_sex_code')} as gender,
    ${copyAgeGroupSql('r.age_in_years')} as age_group,
    r.agein_days,
    ${classSql('r.mtb', MTB_CLASSES)} as mtb,
    ${classSql('r.rif', RIF_CLASSES)} as rif,
    r.tbhiv, r.tbage, r.dist_tb_number,
    case when ${inListSql('r.lims_panel_code', ['POCGT'])} or ${isNumericSql('r.tested_at')} then 1 else 0 end as poc,
    c.tat,
    case when c.tat < 24 then 1 else 0 end as w24h,
    case when c.tat < 48 then 1 else 0 end as w48h,
    case when c.tat < 72 then 1 else 0 end as w72h
  from ${name}_rows r
  cross join lateral (select (${hoursBetweenSql('r.specimen_date_time', 'r.authorised_date_time')})::int as tat) c
  where ${foldSql('r.tested_at')} <> '000'
)`;
}

// ---- Small v1 functions used by the recency and request tables ----

// The gender case of the recency tables (sp_getTestLevelRecency_CIDRZ lines 21-27, sp_recency_surveillance lines
// 29-35): F, M, U and I; everything else, and a missing sex, is 'Missing'. The compare ignores case and trailing
// spaces, as SQL Server does.
export const genderMissingSql = (sexExpr) => `case upper(rtrim(${sexExpr})) when 'F' then 'Female' when 'M' then 'Male' when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Missing' end`;

// v1 datepart(wk, d) for a DATE expression: the US week, Sunday first, week 1 holds 1 January (SQL Server's default
// DATEFIRST 7). NULL for a NULL date. These are not ISO weeks: week 1 and the last week are partial.
export const dateWeekSql = (dateExpr) => `((extract(doy from ${dateExpr})::int - 1 + extract(dow from make_date(extract(year from ${dateExpr})::int, 1, 1))::int) / 7 + 1)`;

// A result text as a number after v1's REPLACE(x, ',', ''), or NULL when SQL Server's ISNUMERIC would say no. A
// currency sign is not parsed: v1's CONVERT(float, '$5') fails, so such a text has no number here. The exponent has at
// most three digits.
const NUMBER_TEXT = String.raw`^\s*[-+]?(\d[\d,]*(\.\d*)?|\.\d+)([eE][-+]?\d{1,3})?\s*$`;
export const numberOfTextSql = (x) => `(case when ${x} ~ ${sqlLit(NUMBER_TEXT)} then replace(${x}, ',', '')::numeric end)`;

// A date text as 'YYYY-MM-DD', or NULL. Two forms are read: dd/mm/yyyy (the form cdr measured in LIMSRptResult for the
// date results, apps/cli/src/compare/v1-coverage.ts) and yyyy-mm-dd, each with optional surrounding spaces. A date that
// does not exist ('31/02/2026'), a year 0000, any other form and NULL give NULL. It never raises.
const DMY_TEXT = String.raw`^\s*([0-9]{2})/([0-9]{2})/([0-9]{4})\s*$`;
const YMD_TEXT = String.raw`^\s*([0-9]{4})-([0-9]{2})-([0-9]{2})\s*$`;
const isoDateOfTextSql = (x) => `(select case
      when p.y >= 1 and p.m between 1 and 12 and p.d between 1 and 31 then
        case when extract(month from make_date(p.y, p.m, 1) + (p.d - 1)) = p.m then to_char(make_date(p.y, p.m, 1) + (p.d - 1), 'YYYY-MM-DD') end
    end
    from (select
      coalesce((regexp_match(${x}, ${sqlLit(DMY_TEXT)}))[3], (regexp_match(${x}, ${sqlLit(YMD_TEXT)}))[1])::int as y,
      coalesce((regexp_match(${x}, ${sqlLit(DMY_TEXT)}))[2], (regexp_match(${x}, ${sqlLit(YMD_TEXT)}))[2])::int as m,
      coalesce((regexp_match(${x}, ${sqlLit(DMY_TEXT)}))[1], (regexp_match(${x}, ${sqlLit(YMD_TEXT)}))[3])::int as d) p)`;

// ---- The recency and recency_surveillance copy tables ----

// Panels and observations of both procedures (sp_getTestLevelRecency_CIDRZ lines 58, 66; sp_recency_surveillance
// lines 64, 73). The surveillance list has no HIVTM.
const RECENCY_PANEL = 'RTRI';
const BASELINE_PANEL = 'HIVVL';
const RECENCY_OBSERVATIONS = ['RTRI', 'HIVVL', 'HIVVC', 'HIVVD', 'HIVTM'];
const SURVEILLANCE_OBSERVATIONS = ['RTRI', 'HIVVL', 'HIVVC', 'HIVVD'];
const BASELINE_OBSERVATIONS = ['HIVVL', 'HIVVC', 'HIVVD', 'HIVTM'];
// sp_getTestLevelRecency_CIDRZ line 71 and sp_recency_surveillance lines 159-162. The two lists differ.
const RECENCY_SUPPRESSED = ['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<40 copies/mL', '<400 copies/mL', '<400', '<883 copies/mL'];
const SURVEILLANCE_SUPPRESSED = ['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<400 copies/mL', '<400', '<40 copies/mL'];
// sp_recency_surveillance line 124.
const MODALITIES = ['PMTCT', 'VCT', 'PITC', 'VMMC', 'Other', 'Index'];
// sp_getTestLevelRecency_CIDRZ lines 86-98: the first three characters of a lab number name the testing lab.
const RECENCY_LAB_PREFIXES = [['ZAP', 'Arthur Davison Childrens Hospital Lab'], ['ZKT', 'Kitwe Teaching Hospital Lab'],
  ['ZUE', 'UTH HAP PCOE Lab'], ['ZUA', 'UTH HAP ACOE Lab'], ['ZUL', 'UTH Virology Lab'], ['ZUF', 'UTH Virology Lab'],
  ['ZCH', 'CHAZ Complex Lab'], ['ZFP', 'Levy Mwanawasa UTH Lab'], ['ZBP', 'Kabwe General Hospital Lab'],
  ['ZCM', 'Choma General Hospital Lab'], ['ZMB', 'Mazabuka General Hospital Lab'],
  ['ZLR', 'Livingstone Teaching Hospital Lab'], ['ZLP', 'Livingstone Teaching Hospital Lab']];

// The lab numbers that have an RTRI request registered in the window (sp_getTestLevelRecency_CIDRZ lines 59-62,
// sp_recency_surveillance lines 65-69). `finalRange` is the window on lr.authored_at ('' without a window).
const recencyIdsSql = (finalRange) => `select distinct lr.request_id as lab_id
    from lab_requests lr
    where ${inListSql('lr.panel_code', [RECENCY_PANEL])}
      ${finalRange}`;

// A request row is used when its lab number has such an RTRI request and the row itself is registered in the window
// (sp_getTestLevelRecency_CIDRZ lines 59-63).
const recencyScopeSql = (ids, finalRange) => `lr.request_id in (select i.lab_id from ${ids} i)
      ${finalRange}`;

// The suppression status of a baseline viral load text. `words` is the suppressed list and `unsuppressedText` the SQL
// for the extra "unsuppressed" test on the text (the two procedures differ). A number under 1000 is suppressed and a
// number from 1000 up is not. A text that is no number and on no list gives NULL.
const suppressionSql = (vl, words, unsuppressedText) => {
  const n = numberOfTextSql(vl);
  return `case
      when (${vl} is not null and not ${isNumericSql(vl)} and ${inListSql(vl, words)}) or ${n} < 1000 then 'Suppressed'
      when ${n} >= 1000 or ${unsuppressedText} then 'UnSuppressed'
    end`;
};

// The reporting status from the recency result and the suppression status (sp_getTestLevelRecency_CIDRZ lines
// 117-122, sp_recency_surveillance lines 175-180).
const reportingStatusSql = (recency, suppression) => `case
      when ${foldSql(recency)} = 'long term' then 'Long-Term RTRI'
      when ${foldSql(recency)} = 'recent' and ${suppression} is null then 'Recent RTRI'
      when ${foldSql(recency)} = 'recent' and ${suppression} = 'Suppressed' then 'Confirmed Long-Term'
      when ${foldSql(recency)} = 'recent' and ${suppression} = 'UnSuppressed' then 'Confirmed Recent'
    end`;

// Zambia's `Recency` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   recencyCte('rc')                              all rows
//   recencyCte('rc', { from: 'from', to: 'to' })  only RTRI requests registered in the window; the two values are
//                                                 parameter names, compared as in inRange
// v1 sp_getTestLevelRecency_CIDRZ drops the table and fills it again on every run. The CTE returns what the table
// holds after a run. get_Test_level_Recency and get_Test_level_Recency_ZNPHI read it (and tb_edits, see the gaps).
//
// Window: the REGISTERED date, lab_requests.authored_at (v1 RegisteredDateTime, lines 61 and 63). v1's fixed window
// is 2023-10-01 to the end of the current week; the caller passes it as from and to. v1 starts at 00:00:00.001, so a
// request registered exactly at midnight on the first day is out in v1; here the whole first day is in. A lab number
// is in the report when one of its RTRI requests is registered in the window. Every row used (the RTRI row, the
// HIVVL rows) must itself be registered in the window. The answers (modality and the rest) have no window.
//
// Columns, in the order of Table__dbo_Recency.sql, in snake_case:
//   province, district, facility, moh_facility_code, ip, lab_id, gender, age_in_years, recency_result,
//   baseline_vl_result, suppression_status, testing_laboratory, sample_collection_date, date_registered, tested_date,
//   reviewed_date, reporting_status, modality, pregnant, breastfeeding, recency_test_date
// The four dates are CE's ISO text. sample_collection_date = diagnostic_reports.effective (SpecimenDateTime),
// date_registered = lab_requests.authored_at, tested_date = lab_requests.analysis_at (AnalysisDateTime, line 42) and
// reviewed_date = diagnostic_reports.issued (AuthorisedDateTime, line 43).
//
// Rules, with v1 lines:
//   - One row per RTRI-panel request row and result row whose observation is RTRI, HIVVL, HIVVC, HIVVD or HIVTM
//     (lines 58, 66), left-joined to the result rows of the lab number's HIVVL-panel requests (lines 105-111). There
//     is no test on the report status. The requesting facility must be mapped to a ZMFAC register row with a province
//     (line 112; v1 left-joins its dictionary and then drops rows with no province).
//   - recency_result is the result text (rpt) of the RTRI observation, else NULL (line 30). baseline_vl_result is the
//     text of a HIVVL, HIVVC, HIVVD or HIVTM observation of the HIVVL-panel rows (line 33).
//   - suppression_status (lines 70-74): a text on the list of eight, or a number under 1000, is 'Suppressed'; a number
//     of 1000 or more, or the text '> 10000000', is 'UnSuppressed'; anything else, and no baseline, is NULL.
//   - reporting_status (lines 117-122): 'Long Term' is 'Long-Term RTRI'; 'Recent' with no suppression status is
//     'Recent RTRI'; 'Recent' and Suppressed is 'Confirmed Long-Term'; 'Recent' and UnSuppressed is 'Confirmed
//     Recent'; any other recency result gives NULL.
//   - gender: F, M, U, I, else 'Missing' (lines 21-27). age_in_years is lab_requests.age_years.
//   - modality is the RTMOD result, pregnant the VPREG or ARTPR result, breastfeeding the VBREA result and
//     recency_test_date the RTRTD result, all taken from RTRI-panel rows of the lab number (lines 123-148). RTRI is
//     a lab panel in Zambia, so these are lab results, not form answers.
//   - testing_laboratory: the first three characters of the lab number name 13 labs (lines 85-100). Any other prefix
//     takes the name of ruling 8: the report's display, else the mapped register name, else the performer's code.
//
// Kept v1 quirks (spec ruling 1):
//   - Rows multiply. A lab number with two HIVVL results gives one row per baseline result. Two answers to one question
//     (VPREG and ARTPR together, or two OBR sets) give one row each.
//   - An RTRI-panel result with another observation (HIVVL in the RTRI panel) is a row with an empty recency_result,
//     an empty baseline_vl_result and an empty reporting_status. The baseline is read from HIVVL-panel rows only.
//   - The HIVVL-panel rows need no mapped facility. Only the RTRI row does.
//   - Text compares ignore case and trailing spaces, as SQL Server does. Values come through as stored.
//   - A text on no list stays: 'Failed' is a baseline with no suppression status.
//   - '<883 copies/mL' is on the suppressed list here, but not in recencySurveillanceCte's.
//   - The compare reads the result TEXT. A number with a comparator reads as its text ('< 20', '> 10000000').
//
// CE gaps and deviations:
//   - ip (IPatner, the implementing partner) has no CE source (ruling 7): the column is NULL.
//   - tb_edits, v1's hand-kept patch table, is not available (ruling 7). get_Test_level_Recency lets a patch fill an
//     empty baseline. Here the column stays as this table has it.
//   - moh_facility_code is the national code of the mapped register row (the MFL code in ZMFAC).
//   - recency_test_date: v1 reads LabResults.DateTimeValue, which CE does not carry. The text is in the result (v1
//     LIMSRptResult holds the same text for 30,198 of 33,004 rows, as dd/mm/yyyy). The column is that text read as a
//     date and shown as 'YYYY-MM-DD' (isoDateOfTextSql). yyyy-mm-dd is read as it is. Any other text, and a date that
//     does not exist, gives NULL.
//   - Dates are CE's ISO text with the offset DISA wrote. v1's are datetimes.
//   - The 13 hardcoded lab prefixes are v1's. For any other lab number v1 joins its Laboratories dictionary on the
//     lab-number prefix (line 103) and takes LabName. The port keys on the report's performer instead (ruling 8: the
//     report's display, else the mapped register name, else the performer's code). So the key differs too, not only
//     the name: a lab number whose prefix and performer name different labs gets another lab than in v1.
export function recencyCte(name, { from, to } = {}) {
  const { finalRange } = copyWindow('recencyCte', from, to, 'lr.authored_at');
  const scope = recencyScopeSql(`${name}_ids`, finalRange);
  const result = rpt('l');
  const answerJoin = (alias, test) => `left join ${name}_ans ${alias} on ${alias}.lab_id = s.lab_id and ${alias}.obs ${test}`;
  return `${name} as (
  with ${name}_ids as (
    ${recencyIdsSql(finalRange)}
  ),
  ${name}_a as (
    select fmr.region as province, fmr.district as district, fmr.name as facility, fmr.national_code as moh_facility_code,
      lr.request_id as lab_id, ${genderMissingSql('p.sex')} as gender, lr.age_years as age_in_years,
      case when ${inListSql('l.observation_code', ['RTRI'])} then ${result} end as recency_result,
      case ${RECENCY_LAB_PREFIXES.map(([prefix, lab]) => `when ${foldSql('left(lr.request_id, 3)')} = ${sqlLit(prefix.toLowerCase())} then ${sqlLit(lab)}`).join(' ')}
        else ${labNameSql('dr')} end as testing_laboratory,
      dr.effective as sample_collection_date, lr.authored_at as date_registered,
      lr.analysis_at as tested_date, dr.issued as reviewed_date
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    ${requesterJoin('lr', 'fmr')}
    left join diagnostic_reports dr on dr.based_on_id = lr.id
    left join patients p on p.id = lr.patient_id
    where ${inListSql('lr.panel_code', [RECENCY_PANEL])}
      and ${inListSql('l.observation_code', RECENCY_OBSERVATIONS)}
      and fmr.region is not null
      and ${scope}
  ),
  ${name}_b as (
    select lr.request_id as lab_id,
      case when ${inListSql('l.observation_code', BASELINE_OBSERVATIONS)} then ${result} end as baseline_vl_result
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    where ${inListSql('lr.panel_code', [BASELINE_PANEL])}
      and ${inListSql('l.observation_code', RECENCY_OBSERVATIONS)}
      and ${scope}
  ),
  ${name}_ans as (
    select lr.request_id as lab_id, ${foldSql('l.observation_code')} as obs, ${result} as answer
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    where ${inListSql('lr.panel_code', [RECENCY_PANEL])}
      and ${inListSql('l.observation_code', ['RTMOD', 'VPREG', 'ARTPR', 'VBREA', 'RTRTD'])}
      and lr.request_id in (select i.lab_id from ${name}_ids i)
  ),
  ${name}_s as (
    select a.*, b.baseline_vl_result,
      ${suppressionSql('b.baseline_vl_result', RECENCY_SUPPRESSED, `${foldSql('b.baseline_vl_result')} = '> 10000000'`)} as suppression_status
    from ${name}_a a
    left join ${name}_b b on b.lab_id = a.lab_id
  )
  select s.province, s.district, s.facility, s.moh_facility_code, null::text as ip, s.lab_id, s.gender, s.age_in_years,
    s.recency_result, s.baseline_vl_result, s.suppression_status, s.testing_laboratory,
    s.sample_collection_date, s.date_registered, s.tested_date, s.reviewed_date,
    ${reportingStatusSql('s.recency_result', 's.suppression_status')} as reporting_status,
    x.answer as modality, y.answer as pregnant, z.answer as breastfeeding, ${isoDateOfTextSql('q.answer')} as recency_test_date
  from ${name}_s s
  ${answerJoin('x', "= 'rtmod'")}
  ${answerJoin('y', "in ('vpreg', 'artpr')")}
  ${answerJoin('z', "= 'vbrea'")}
  ${answerJoin('q', "= 'rtrtd'")}
)`;
}

// Zambia's `Recency_Surveillance` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   recencySurveillanceCte('rs')                              all rows
//   recencySurveillanceCte('rs', { from: 'from', to: 'to' })  only RTRI requests registered in the window
// v1 sp_recency_surveillance drops the table and fills it again on every run. get_Test_level_Recency_Surveillance is
// `select *` from it. The CTE returns what the table holds after a run. It has no order (v1's table has none); the
// query that reads it must order by every column.
//
// Window: the REGISTERED date, lab_requests.authored_at (lines 67 and 70), as in recencyCte. v1's fixed window is
// 2023-10-01 to the end of the current week.
//
// Columns, in the order of Table__dbo_Recency_Surveillance.sql, in snake_case:
//   province, district, facility, implementing_partner, age_group, gender, recency_result, suppression_status,
//   reporting_status, modality, reg_year, reg_quarter, month, week, count
//
// Rules, with v1 lines:
//   - The rows are the RTRI-panel request rows and result rows with observation RTRI, HIVVL, HIVVC or HIVVD (line 73;
//     no HIVTM, unlike recencyCte). Each is left-joined to the RTMOD rows of the lab number (lines 115-154, either
//     panel) and to the result rows of its HIVVL-panel requests (lines 155-172). The requesting facility must be
//     mapped to a ZMFAC register row with a province (line 189).
//   - recency_result is the RTRI result text. The baseline is the text of a HIVVL, HIVVC or HIVVD observation of the
//     HIVVL-panel rows (line 41); it is not a column, only the suppression status is.
//   - modality is the RTMOD result when it is PMTCT, VCT, PITC, VMMC, Other or Index, else NULL (lines 124-127). A lab
//     number with RTMOD results on both panels gives a row each.
//   - suppression_status (lines 158-165): a text on the list of seven, or a number under 1000, is 'Suppressed'; a
//     number of 1000 or more, or any text starting with '>', is 'UnSuppressed'; anything else is NULL.
//   - reporting_status as in recencyCte (lines 175-180).
//   - age_group (lines 17-28): '15 - 19', '20 - 24', ..., '45 - 49' (with spaces), '50+' for over 50, 'Missing' for no
//     age, and '<15' for everything else.
//   - gender as in recencyCte (lines 29-35).
//   - reg_year, reg_quarter, month and week come from the RTRI row's registered date (lines 47-50). The date is the
//     LOCAL date, taken from the stamp's own text. week is datepart(wk): the US week, Sunday first (dateWeekSql).
//   - count is the number of distinct lab numbers in the group (line 186).
//
// Kept v1 quirks (spec ruling 1):
//   - Age 50 is '<15': the test is "over 50" (line 25). Ages under 15, age 0 and negative ages are '<15' too.
//   - An RTRI-panel result with another observation (HIVVD in the RTRI panel) is a row with an empty recency_result,
//     an empty suppression_status and an empty reporting_status.
//   - A lab number with baseline results in two classes counts once in each group.
//   - Text compares ignore case and trailing spaces, as SQL Server does. modality and recency_result come through as
//     stored ('vct' stays 'vct').
//   - '<883 copies/mL' is not on this list, so it gives no suppression status (recencyCte counts it as suppressed).
//
// CE gaps and deviations:
//   - implementing_partner has no CE source (ruling 7): the column is NULL.
//   - v1 converts the baseline to INT (line 162). That stops the whole procedure on a decimal ('540.5') or a number over
//     2,147,483,647. A procedure that stops gives no output, so the port reads the text as a number and a decimal is
//     under or over 1000 as it looks.
//   - v1 groups the rows once before the joins (lines 74-111). The counts are of distinct lab numbers, so that step
//     cannot change them and is left out.
//   - v1 groups and counts with SQL Server's default collation (lines 186-201), so 'VCT' and 'vct ', or 'Recent' and
//     'recent', fall in one group, and two spellings of a lab number are one lab. The port groups on foldSql (lower case,
//     no trailing spaces) of province, district, facility, recency_result and modality, and counts distinct folded lab
//     numbers. The text shown is min() of the spellings in the group. v1 shows one of them too, and which one is not
//     defined, so a group of mixed spellings may show a different spelling than v1 did. The other keys are literals.
//   - Dates are CE's ISO text; the local date comes from the text with no UTC shift.
export function recencySurveillanceCte(name, { from, to } = {}) {
  const { finalRange } = copyWindow('recencySurveillanceCte', from, to, 'lr.authored_at');
  const scope = recencyScopeSql(`${name}_ids`, finalRange);
  const result = rpt('l');
  const age = '(lr.age_years)';
  return `${name} as (
  with ${name}_ids as (
    ${recencyIdsSql(finalRange)}
  ),
  ${name}_y as (
    select lr.request_id as lab_id, fmr.region as province, fmr.district as district, fmr.name as facility,
      case
        when ${age} between 15 and 19 then '15 - 19'
        when ${age} between 20 and 24 then '20 - 24'
        when ${age} between 25 and 29 then '25 - 29'
        when ${age} between 30 and 34 then '30 - 34'
        when ${age} between 35 and 39 then '35 - 39'
        when ${age} between 40 and 44 then '40 - 44'
        when ${age} between 45 and 49 then '45 - 49'
        when ${age} > 50 then '50+'
        when ${age} is null then 'Missing'
        else '<15'
      end as age_group,
      ${genderMissingSql('p.sex')} as gender,
      case when ${inListSql('l.observation_code', ['RTRI'])} then ${result} end as recency_result,
      ${localDate('lr.authored_at')} as reg_date
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    ${requesterJoin('lr', 'fmr')}
    left join patients p on p.id = lr.patient_id
    where ${inListSql('lr.panel_code', [RECENCY_PANEL])}
      and ${inListSql('l.observation_code', SURVEILLANCE_OBSERVATIONS)}
      and fmr.region is not null
      and ${scope}
  ),
  ${name}_z as (
    select lr.request_id as lab_id,
      case when ${inListSql('l.observation_code', ['HIVVL', 'HIVVC', 'HIVVD'])} then ${result} end as baseline_vl_result
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    where ${inListSql('lr.panel_code', [BASELINE_PANEL])}
      and ${inListSql('l.observation_code', SURVEILLANCE_OBSERVATIONS)}
      and ${scope}
  ),
  ${name}_xb as (
    select lr.request_id as lab_id, case when ${inListSql(result, MODALITIES)} then ${result} end as modality
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    where ${inListSql('lr.panel_code', [RECENCY_PANEL, BASELINE_PANEL])}
      and ${inListSql('l.observation_code', ['RTMOD'])}
      and ${scope}
  ),
  ${name}_alpha as (
    select y.province, y.district, y.facility, y.age_group, y.gender, y.lab_id, y.recency_result,
      ${suppressionSql('z.baseline_vl_result', SURVEILLANCE_SUPPRESSED, "z.baseline_vl_result like '>%'")} as suppression_status,
      xb.modality,
      extract(year from y.reg_date)::int as reg_year, extract(quarter from y.reg_date)::int as reg_quarter,
      extract(month from y.reg_date)::int as month, ${dateWeekSql('y.reg_date')} as week
    from ${name}_y y
    left join ${name}_xb xb on xb.lab_id = y.lab_id
    left join ${name}_z z on z.lab_id = y.lab_id
  )
  select min(a.province) as province, min(a.district) as district, min(a.facility) as facility,
    null::text as implementing_partner, a.age_group, a.gender, min(a.recency_result) as recency_result,
    a.suppression_status, ${reportingStatusSql('a.recency_result', 'a.suppression_status')} as reporting_status,
    min(a.modality) as modality, a.reg_year, a.reg_quarter, a.month, a.week,
    count(distinct ${foldSql('a.lab_id')})::int as count
  from ${name}_alpha a
  group by ${foldSql('a.province')}, ${foldSql('a.district')}, ${foldSql('a.facility')}, a.age_group, a.gender,
    ${foldSql('a.recency_result')}, a.suppression_status, ${reportingStatusSql('a.recency_result', 'a.suppression_status')},
    ${foldSql('a.modality')}, a.reg_year, a.reg_quarter, a.month, a.week
)`;
}

// ---- The VLEIDRequests copy table ----

// sp_UpdateVLEIDRequests line 23.
const VLEID_PANELS = ['HIVPC', 'HIVST', 'HIVVL', 'VIRAL'];

// The window columns of vleidRequestsCte, `on`: [on a request row, on a VIRAL row]. A VIRAL row has no analysis or
// authorised date, so it is out of a window on either.
const VLEID_WINDOWS = {
  registered: ['lr.authored_at', 'lr.authored_at'],
  period: ['coalesce(dr.effective, s.received_time, lr.authored_at)', 'coalesce(dr.effective, s.received_time, lr.authored_at)'],
  specimen_or_registered: ['coalesce(dr.effective, lr.authored_at)', 'coalesce(dr.effective, lr.authored_at)'],
  analysis: ['lr.analysis_at', 'null::text'],
  authorised: ['dr.issued', 'null::text'],
};

// The table's columns, in order: [column, the select item of a request row, the select item of a VIRAL row (the
// same when left out)]. `lr` is the lab request, `dr` its report, `s` the report's specimen, `p` the patient.
const VLEID_COLUMNS = [
  ['date_time_stamp', 'null::text'],
  ['versionstamp', 'null::text'],
  ['lims_date_time_stamp', 'null::text'],
  ['lims_versionstamp', 'null::text'],
  ['request_id', 'lr.request_id'],
  ['obr_set_id', 'lr.obr_set_id'],
  ['loinc_panel_code', 'null::text'],
  ['lims_panel_code', 'lr.panel_code', "'VIRAL'::text"],
  ['lims_panel_desc', 'lr.panel_desc', 'null::text'],
  ['hl7_priority_code', `case ${foldSql('lr.priority')} when 'routine' then 'R' when 'urgent' then 'U' when 'stat' then 'S' end`],
  ['specimen_date_time', 'dr.effective'],
  ['registered_date_time', 'lr.authored_at'],
  ['received_date_time', 's.received_time'],
  ['analysis_date_time', 'lr.analysis_at', 'null::text'],
  ['authorised_date_time', 'dr.issued', 'null::text'],
  ['admit_attend_date_time', 'null::text'],
  ['collection_volume', 'null::float8'],
  ['requesting_facility_code', 'lr.requester_code'],
  ['receiving_facility_code', 'null::text'],
  ['lims_point_of_care_desc', 'lr.point_of_care'],
  ['request_type_code', 'lr.request_type'],
  ['icd10_clinical_info_codes', 'null::text'],
  ['clinical_info', 'lr.clinical_info'],
  ['hl7_specimen_source_code', 'null::text'],
  ['lims_specimen_source_code', 's.type_code'],
  ['lims_specimen_source_desc', 's.type_text'],
  ['hl7_specimen_site_code', 'null::text'],
  ['lims_specimen_site_code', 'null::text'],
  ['lims_specimen_site_desc', 'null::text'],
  ['work_units', 'null::float8'],
  ['cost_units', 'null::float8'],
  ['hl7_section_code', 'dr.section_code', 'null::text'],
  ['hl7_result_status_code', `case ${foldSql('dr.status')} when 'final' then 'F' when 'cancelled' then 'X' end`, 'null::text'],
  ['registered_by', 'lr.registered_by'],
  ['tested_by', 'lr.tested_by', 'null::text'],
  ['authorised_by', 'dr.authorised_by', 'null::text'],
  ['ordering_notes', 'null::text'],
  ['encrypted_patient_id', 'null::text'],
  ['age_in_years', 'lr.age_years'],
  ['age_in_days', 'lr.age_days'],
  ['hl7_sex_code', 'p.sex'],
  ['hl7_ethnic_group_code', 'null::text'],
  ['deceased', 'null::boolean'],
  ['newborn', 'null::boolean'],
  ['hl7_patient_class_code', 'null::text'],
  ['attending_doctor', 'lr.requester_practitioner'],
  ['testing_facility_code', 'dr.performer'],
  ['referring_request_id', requestAttrSql('lr.id', 'referring-request-id')],
  ['therapy', 'null::text'],
  ['lims_analyzer_code', 'lr.analyzer_code', 'null::text'],
  ['target_time_days', 'null::int'],
  ['target_time_mins', 'null::int'],
  ['lims_rejection_code', 'lr.rejection_code', 'null::text'],
  ['lims_rejection_desc', 'lr.rejection_reason', 'null::text'],
  ['lims_facility_code', 'lr.requester_code'],
  ['repeated', 'null::int'],
];

// Zambia's `VLEIDRequests` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   vleidRequestsCte('vl')                                         all rows
//   vleidRequestsCte('vl', { from: 'from', to: 'to' })             only rows registered in the window
//   vleidRequestsCte('vl', { from: 'from', to: 'to', on: 'period' })  the window is on another date (see below)
// v1 sp_UpdateVLEIDRequests merges every Requests row of four panels into the table (lines 19-87); it never deletes.
// The CTE returns what the table holds when it is up to date: one row per lab request row (request number and OBR
// set) of the panels HIVPC, HIVST, HIVVL and VIRAL (line 23), plus the VIRAL rows below. The view `Requests` of
// Zambia's reporting database is `select *` from this table. The v1 objects that read the copy table are the view
// Requests, vVLReportData, vVLReportDatab and vReceivedRequestsSummary.
// vWeeklyRequestTrend does NOT: it reads OpenLDRData.dbo.Requests, which holds every panel, so it must use plain
// lab_requests, not this builder. fn_WeeklyLISUpdate reads OpenLDRData.dbo.Requests too; this builder only covers its
// panels HIVPC and HIVVL (and none of its other filters), so it is a superset there, not the source.
//
// Window: `from` and `to` are parameter names, compared as in inRange (the local date of the stamp). The window only
// limits the rows read; each consumer applies its own v1 edges on top. `on` picks the date column:
//   'registered' (the default)  lab_requests.authored_at, v1 RegisteredDateTime
//   'specimen_or_registered'    coalesce(specimen date, registered date), the bucket date of vReceivedRequestsSummary
//                               (View lines 25-28 and 62-65: year, quarter, month and week of
//                               coalesce(SpecimenDateTime, RegisteredDateTime)). The local date of the stamp.
//   'period'                    coalesce(specimen date, received date, registered date). No v1 consumer of this copy
//                               table uses it (vWeeklyRequestTrend has that coalesce, but it does not read the copy
//                               table). It differs from 'specimen_or_registered' for a request with no specimen date
//                               and a received date.
//   'analysis'                  lab_requests.analysis_at, v1 AnalysisDateTime
//   'authorised'                diagnostic_reports.issued, v1 AuthorisedDateTime
// A bad `on`, or only one of from and to, throws.
//
// Columns, in the order of Table__dbo_VLEIDRequests.sql (56 columns), in snake_case: date_time_stamp, versionstamp,
// lims_date_time_stamp, lims_versionstamp, request_id, obr_set_id, loinc_panel_code, lims_panel_code, lims_panel_desc,
// hl7_priority_code, specimen_date_time, registered_date_time, received_date_time, analysis_date_time,
// authorised_date_time, admit_attend_date_time, collection_volume, requesting_facility_code, receiving_facility_code,
// lims_point_of_care_desc, request_type_code, icd10_clinical_info_codes, clinical_info, hl7_specimen_source_code,
// lims_specimen_source_code, lims_specimen_source_desc, hl7_specimen_site_code, lims_specimen_site_code,
// lims_specimen_site_desc, work_units, cost_units, hl7_section_code, hl7_result_status_code, registered_by, tested_by,
// authorised_by, ordering_notes, encrypted_patient_id, age_in_years, age_in_days, hl7_sex_code, hl7_ethnic_group_code,
// deceased, newborn, hl7_patient_class_code, attending_doctor, testing_facility_code, referring_request_id, therapy,
// lims_analyzer_code, target_time_days, target_time_mins, lims_rejection_code, lims_rejection_desc, lims_facility_code,
// repeated
// The five date-time columns are CE's ISO text (specimen_date_time = diagnostic_reports.effective, registered_date_time
// = lab_requests.authored_at, received_date_time = specimens.received_time, analysis_date_time = lab_requests.analysis_at,
// authorised_date_time = diagnostic_reports.issued). The load stamps are NULL.
//
// From where, column by column:
//   lab_requests:        request_id, obr_set_id, lims_panel_code (panel_code), lims_panel_desc, registered_date_time,
//                        analysis_date_time, requesting_facility_code and lims_facility_code (both requester_code),
//                        lims_point_of_care_desc, request_type_code, clinical_info, registered_by, tested_by,
//                        attending_doctor (requester_practitioner), age_in_years, age_in_days, lims_analyzer_code,
//                        lims_rejection_code, lims_rejection_desc (rejection_reason)
//   diagnostic_reports:  specimen_date_time (effective), authorised_date_time (issued), hl7_section_code,
//                        authorised_by, testing_facility_code (performer), hl7_result_status_code
//   specimens:           received_date_time, lims_specimen_source_code (type_code), lims_specimen_source_desc (type_text)
//   patients:            hl7_sex_code (sex, as stored)
//   request attribute:   referring_request_id ('referring-request-id'; cdr-toolchain does not fill it yet, so it is
//                        NULL until it does)
//   computed:            hl7_priority_code (CE holds the FHIR word that cdr made from R, U and S: routine, urgent, stat
//                        become R, U, S again; anything else is NULL), hl7_result_status_code (final is F, cancelled is
//                        X; CE folds every other v1 status to unknown, so those are NULL)
//
// VIRAL (spec ruling 6): cdr-toolchain sends Zambia's VIRAL panel as a form, not as a request (config/zambia.yaml). CE
// has no lab_requests row with the panel VIRAL; it has a questionnaire_responses row of form hiv_vl_documentation whose
// based_on_id is the request of the specimen's first ordered panel. v1 does hold a VIRAL request, and the consumers count
// it (vReceivedRequestsSummary counts HIVVL and VIRAL as viral load requests). So each lab request row with such a form
// gives one more row with lims_panel_code 'VIRAL'. It copies the request's registration facts: lab number, OBR set,
// priority, specimen, registered and received dates, facility, point of care, request type, clinical info, specimen
// source, registered by, age, sex, doctor, testing lab, referring request id. It leaves the test's own facts NULL:
// panel description, analysis and authorised dates, result status, section, tested by, authorised by, analyzer and
// rejection. Several answers on one request give one VIRAL row. A form with no request, or with a request CE does not
// hold, gives no row. If CE does hold a VIRAL lab request for the lab number, that row is the VIRAL request and the
// form adds none. The window on a VIRAL row uses its own (copied) dates, so it is out of an 'analysis' or 'authorised'
// window.
//
// Kept v1 quirks (spec ruling 1):
//   - The table is a plain copy: no facility join, no result join, no test on the report status. A request whose
//     facility is not in the register is a row; so is one with no report (its report columns are NULL).
//   - The panel code and the other text come through as stored. The panel test ignores case and trailing spaces, as SQL
//     Server's IN does ('hivvl ' is HIVVL, and keeps its text).
//   - The merge key is RequestID and OBRSetID (line 25), so the table holds one row per request and OBR set. CE's
//     lab_requests holds the same grain.
//
// CE gaps (spec ruling 7): date_time_stamp, versionstamp, lims_date_time_stamp and lims_versionstamp (v1 load stamps),
// loinc_panel_code, hl7_specimen_source_code, the specimen site columns, admit_attend_date_time, collection_volume,
// receiving_facility_code, icd10_clinical_info_codes, work_units, cost_units, ordering_notes, encrypted_patient_id,
// hl7_ethnic_group_code, deceased, newborn, hl7_patient_class_code, therapy, target_time_days, target_time_mins and
// repeated are NULL. v1 holds '' for an absent text, CE has NULL: a consumer that tests `= ''` must test for NULL too
// (blankSql). lims_facility_code is lab_requests.requester_code: v1's LimsFacilityCode (the DISA facility) and
// RequestingFacilityCode are one code in CE. hl7_priority_code and hl7_result_status_code are rebuilt from CE's words and
// lose what CE folded (for status: v1's Y, Z and the like).
// VIRAL gaps: the synthetic VIRAL row copies the host request's obr_set_id; v1's VIRAL row has its own OBR set (counts of
// distinct RequestID are not affected). v1 has VIRAL rows the port cannot see: a specimen whose only panel is VIRAL
// (cdr's toDocumentationFhir returns [] when there is no order graph to attach the form to) and a VIRAL panel with no
// answers (no form is made).
export function vleidRequestsCte(name, { from, to, on = 'registered' } = {}) {
  const windows = VLEID_WINDOWS[on];
  if (windows === undefined) throw new Error(`vleidRequestsCte: on must be one of ${Object.keys(VLEID_WINDOWS).join(', ')}`);
  const real = copyWindow('vleidRequestsCte', from, to, windows[0]).finalRange;
  const viral = copyWindow('vleidRequestsCte', from, to, windows[1]).finalRange;
  const items = (isViral) => VLEID_COLUMNS.map(([column, requestItem, viralItem]) => `${isViral && viralItem !== undefined ? viralItem : requestItem} as ${column}`).join(',\n    ');
  const joins = `from lab_requests lr
    left join diagnostic_reports dr on dr.based_on_id = lr.id
    left join specimens s on s.id = dr.specimen_id
    left join patients p on p.id = lr.patient_id`;
  return `${name} as (
  select ${items(false)}
    ${joins}
    where ${inListSql('lr.panel_code', VLEID_PANELS)}
      ${real}
  union all
  select ${items(true)}
    ${joins}
    where exists (select 1 from questionnaire_responses qr where qr.form_code = ${sqlLit(VL_FORM_CODE)} and qr.based_on_id = lr.id)
      and not exists (select 1 from lab_requests v where v.request_id = lr.request_id and ${inListSql('v.panel_code', ['VIRAL'])})
      ${viral}
)`;
}

// ---- The testing summaries by area (sp_getSummaryTestEpiData*, sp_getSummaryTestEpiDataEID*) ----

// One query of the epi summaries: v1's five CTEs (registrations, tests, two result splits, turnaround) per requesting
// facility, joined on the facility code and summed by area name. All six v1 procedures have this shape and differ in the
// lists, the end date, the area they group by and which CTE the joins hang off, so those are the options.
//   panel, observations   the panel and the observation codes of the results (compared ignoring case)
//   anchor                'reg' or 'tests': the CTE every other CTE is joined to. A facility with no row in the anchor is
//                         dropped with all its other counts (v1 keys its joins on registrations.RequestingFacilityCode in the
//                         VL procedures and on tests.RequestingFacilityCode in the EID ones; the full outer joins keep the
//                         other rows, but they have no area and the where clause drops them)
//   endExtraDays          days added to `to` (the VL province procedure moves @EndDate a day forward). v1 compares datetimes
//                         with dates: the window runs from `from` 00:00:00 to `to` 00:00:00 inclusive, local wall time
//   lead                  [[output name, expression on fmr]] the group columns, e.g. [['District', 'fmr.district']]; fmr is
//                         the mapped ZMFAC row of the requesting facility (unmapped facilities drop out)
//   area                  the filter on fmr that decides which facilities count (province or district parameter)
//   resultWhere           an extra condition on the result text `rpt('l')` for the tests and the splits (VL's invalid list)
//   splits                [{ column, cond }]: result counts beside Tests, each over the same rows as Tests plus cond
// Counts are of distinct requests, as v1's count(distinct requestid). The turnaround is the whole-day average, cut toward zero as
// SQL Server's int AVG cuts it, over the result rows (not the requests) with a collection date and at most 90 days to the
// authorised date; TATTests counts those requests and TATpre = average x TATTests, summed over facilities. A sum over nothing is NULL.
// Rows come ordered by the group columns as SQL Server orders text (NULL first).
export function epiSummarySql({ panel, observations, anchor, endExtraDays = 0, lead, area, resultWhere = 'true', splits }) {
  const lo = '({{param.from}})::date::timestamp';
  const hi = endExtraDays === 0 ? '({{param.to}})::date::timestamp' : `(({{param.to}})::date + ${endExtraDays})::timestamp`;
  const within = (expr) => `${localTs(expr)} >= ${lo} and ${localTs(expr)} <= ${hi}`;
  const days = `${localDate('dr.issued')} - ${localDate('dr.effective')}`;
  const finalResults = (name, extraSelect, extraWhere) => `${name} as (
  select fmr.id as fid, count(distinct lr.request_id) as n${extraSelect}
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr')}
  where ${inListSql('lr.panel_code', [panel])}
    and ${inListSql('l.observation_code', observations)}
    and dr.status = 'final'
    and ${within('lr.analysis_at')}
    and ${area}${extraWhere}
  group by fmr.id
)`;
  const splitNames = splits.map((_, i) => `split_${i + 1}`);
  const ctes = [
    `reg as (
  select fmr.id as fid, count(distinct lr.request_id) as n
  from lab_requests lr
  ${requesterJoin('lr', 'fmr')}
  where ${inListSql('lr.panel_code', [panel])}
    and ${within('lr.authored_at')}
    and ${area}
  group by fmr.id
)`,
    finalResults('tests', '', `\n    and ${resultWhere}`),
    ...splits.map((s, i) => finalResults(splitNames[i], '', `\n    and ${resultWhere}\n    and ${s.cond}`)),
    finalResults('tat', `, trunc(avg(${days}))::int as avg_days`, `\n    and dr.effective is not null\n    and ${days} <= 90`),
  ];
  const others = ['reg', 'tests', ...splitNames, 'tat'].filter((c) => c !== anchor);
  const exprs = lead.map(([, expr]) => expr);
  return `with ${ctes.join(',\n')}
select ${lead.map(([name, expr]) => `${expr} as "${name}"`).join(', ')}, sum(reg.n)::bigint as "Registrations", sum(tests.n)::bigint as "Tests",
  ${splits.map((s, i) => `sum(${splitNames[i]}.n)::bigint as "${s.column}"`).join(', ')}, sum(tat.n)::bigint as "TATTests", sum(tat.avg_days * tat.n)::bigint as "TATpre"
from ${anchor}
join facility_map fmr on fmr.id = ${anchor}.fid
${others.map((c) => `left join ${c} on ${c}.fid = ${anchor}.fid`).join('\n')}
group by ${exprs.join(', ')}
order by ${exprs.map((e) => `${ssTextKey(e)} collate "C" nulls first, ${e} collate "C" nulls first`).join(', ')}`;
}
