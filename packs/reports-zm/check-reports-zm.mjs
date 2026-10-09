// Checks the reports-zm query SQL against real Postgres, over a table of cases.
//
//   node packs/reports-zm/check-reports-zm.mjs
//
// Uses the shared runner (../shared/pg-check.mjs): temp copies of the warehouse tables in the CE
// dev Postgres container, rolled back. Exits 1 on any mismatch. Run it by hand before a release.

import { caseSuite, runSuites } from '../shared/pg-check.mjs';
import { artNumberSql } from './zm-queries.mjs';

const suites = [];

// v1 sp_GetPreviousVLResultforCohort2x: the ART number from REFNO, else UNIQUEID. HOSPID is not
// sent yet, so its rule never fires (spec section 3).
suites.push(caseSuite('art-number', ['ref', 'uq'], [
  { ref: ',ELABS 12AT.3456', uq: 'U-1', expected: '3456' },
  { ref: ',elabs xt.99', uq: 'U', expected: '99' },
  { ref: 'ART12345,ELABS 99', uq: 'U', expected: '12345' },
  // v1 raises an error here (RIGHT with a negative length). The port gives ''.
  { ref: 'AB,ELABS', uq: 'U', expected: '' },
  { ref: '', uq: 'AB-12 34', expected: 'AB1234' },
  { ref: ' , AT. ', uq: 'Q-1', expected: 'Q1' },
  { ref: 'ART.555', uq: 'AB-1', expected: 'AB1' },
  { ref: 'elabs.123', uq: 'X-9', expected: 'X9' },
  { ref: ',ART.5', uq: 'Z-1', expected: 'Z1' },
  { ref: '12-345 678,AT.', uq: 'U', expected: '12345678' },
  { ref: '1234at.5', uq: 'U', expected: '12345' },
  { ref: 'A,T.9', uq: 'U', expected: '9' },
  { ref: '', uq: '', expected: '' },
], artNumberSql('ref', 'uq')));

// ---- Suites above this line ----

runSuites(suites);
