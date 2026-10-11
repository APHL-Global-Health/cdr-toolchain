// Every custom query of the pack, in build order: slice 1's query, then each area's.

import { zmQueryFile } from './zm-queries.mjs';
import { queries as vl } from './queries/vl.mjs';
import { queries as eid } from './queries/eid.mjs';
import { queries as tb } from './queries/tb.mjs';
import { queries as tests } from './queries/tests.mjs';
import { queries as covid } from './queries/covid.mjs';
import { queries as labOps } from './queries/lab-ops.mjs';

export const allQueries = () => [...zmQueryFile().queries, ...vl(), ...eid(), ...tb(), ...tests(), ...covid(), ...labOps()];

// The custom-queries file the build writes into the pack.
export const allQueryFile = () => ({ ...zmQueryFile(), queries: allQueries() });
