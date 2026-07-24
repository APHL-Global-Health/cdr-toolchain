import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTransactionBundle } from './fhir-bundle.js';

test('wraps resources into a transaction Bundle with PUT + relative refs', () => {
  const resources = [
    { resourceType: 'ServiceRequest', id: 'obr1' },
    { resourceType: 'Observation', id: 'obs1', basedOn: [{ reference: 'ServiceRequest/obr1' }] },
  ];
  const bundle = toTransactionBundle(resources);
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'transaction');
  assert.equal(bundle.entry.length, 2);
  assert.deepEqual(bundle.entry[0]!.request, { method: 'PUT', url: 'ServiceRequest/obr1' });
  assert.equal(bundle.entry[0]!.fullUrl, 'ServiceRequest/obr1');
  assert.equal(bundle.entry[0]!.resource, resources[0]);
});
