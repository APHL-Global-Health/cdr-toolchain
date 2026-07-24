export interface TransactionBundle {
  resourceType: 'Bundle';
  type: 'transaction';
  entry: { fullUrl: string; resource: Record<string, unknown>; request: { method: 'PUT'; url: string } }[];
}

/** Wrap pre-built FHIR resources (with real deterministic ids) into a FHIR transaction Bundle
 *  using PUT + relative references — idempotent upsert on the CE side. */
export function toTransactionBundle(resources: Record<string, unknown>[]): TransactionBundle {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource) => {
      const url = `${String(resource.resourceType)}/${String(resource.id)}`;
      return { fullUrl: url, resource, request: { method: 'PUT' as const, url } };
    }),
  };
}
