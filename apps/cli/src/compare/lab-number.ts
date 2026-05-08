export interface NormalizedLabNumber {
  /** The DISA `LabNo` form (without the country/system prefix). */
  disaLabNo: string;
  /** The OpenLDR v1 `RequestID` form (with the prefix). */
  openldrRequestId: string;
  /** The prefix that was applied or stripped. */
  prefix: string;
}

export function normalizeLabNumber(input: string, prefix: string): NormalizedLabNumber {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Lab number cannot be empty");
  }

  if (prefix.length > 0 && trimmed.toUpperCase().startsWith(prefix.toUpperCase())) {
    return {
      disaLabNo: trimmed.slice(prefix.length),
      openldrRequestId: trimmed,
      prefix,
    };
  }

  return {
    disaLabNo: trimmed,
    openldrRequestId: prefix + trimmed,
    prefix,
  };
}
