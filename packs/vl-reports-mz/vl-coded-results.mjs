// One description per coded value, for the vl-reports-mz coded-results code system.
//
// v1's ViralLoadResultMerge reads OpenLDRDict.dbo.LIMSCodedValues with no ordering. A code listed
// with two descriptions shows whichever row SQL Server returns. A code system needs one display
// per code. Until the Mozambique team says which v1 shows (QUESTIONS-FOR-MZ.md, question 2): the
// most frequent description wins, and on a tie the first in (LIMSPanelCode, Description) order.
// build.mjs writes every choice to build-summary.json so it can be checked against sample data.

const trim = (v) => (v == null ? '' : String(v).trim());
// Code-unit order, so the result does not depend on the machine's locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function pickCodedResultDisplays(rows) {
  const byCode = new Map();
  const leftOut = [];
  for (const row of rows) {
    const code = trim(row.code);
    if (!code) {
      leftOut.push({ key: trim(row.description), reason: 'blank LIMSCodedValue' });
      continue;
    }
    // v1 shows the code when the description is NULL: ISNULL(Value, @LIMSCodedValue).
    const description = trim(row.description) || code;
    const panel = trim(row.panel);
    if (!byCode.has(code)) byCode.set(code, new Map());
    const seen = byCode.get(code);
    const prev = seen.get(description);
    if (prev) {
      prev.count += 1;
      if (byCodeUnit(panel, prev.panel) < 0) prev.panel = panel;
    } else {
      seen.set(description, { description, count: 1, panel });
    }
  }
  const concepts = [];
  const choices = [];
  for (const code of [...byCode.keys()].sort(byCodeUnit)) {
    const ranked = [...byCode.get(code).values()].sort((a, b) =>
      b.count - a.count || byCodeUnit(a.panel, b.panel) || byCodeUnit(a.description, b.description));
    concepts.push({ code, display: ranked[0].description });
    if (ranked.length > 1) {
      choices.push({ code, chosen: ranked[0].description, descriptions: ranked.map(({ description, count }) => ({ description, count })) });
    }
  }
  return { concepts, choices, leftOut };
}
