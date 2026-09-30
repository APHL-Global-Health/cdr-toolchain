import type { RegistrationOffsets } from "../config/request-fact-config.js";

export interface RegistrationFacts {
  requestType: string | null;
  ageYears: number | null;
  ageDays: number | null;
  /** True only when the configured bit is set. A clear bit and an unmeasured deployment both give false. */
  newborn: boolean;
}

/** Reads the measured single-byte facts from REGDAT4_STATUS (latin1, one char per byte).
 *  Offsets come from config/<country>.yaml; a null offset decodes nothing. */
export function readRegistrationFacts(blob: string | null, offsets: RegistrationOffsets): RegistrationFacts {
  const at = (i: number): number | null => (blob !== null && i < blob.length ? blob.charCodeAt(i) & 0xff : null);
  const rt = offsets.requestType;
  const typeByte = rt === null ? null : at(rt.offset);
  const years = offsets.ageYears === null ? null : at(offsets.ageYears.offset);
  const lo = offsets.ageDays === null ? null : at(offsets.ageDays.offset);
  const hi = offsets.ageDays === null ? null : at(offsets.ageDays.offset + 1);
  const days = lo === null || hi === null ? null : lo + 256 * hi;
  const flags = offsets.newborn === null ? null : at(offsets.newborn.offset);
  return {
    requestType: typeByte === null || rt === null ? null : rt.values.get(typeByte) ?? null,
    ageYears: years === null || years === 0 ? null : years,
    ageDays: days === null || days === 0 ? null : days,
    newborn: flags !== null && offsets.newborn !== null && (flags & offsets.newborn.mask) !== 0,
  };
}
