export interface ReportingLimits {
  lowLimit: number | null;
  highLimit: number | null;
}

export interface CensoredNumeric {
  value: number;
  comparator: "<" | ">" | null;
}

/** The limits are float32 values widened to double, so 0.14 reads as
 *  0.14000000059604645. Send the limit the lab typed, not the widened one. */
function tidyLimit(limit: number): number {
  return Number(limit.toPrecision(7));
}

/** A result below the low limit goes out as "< low". A result above the high
 *  limit goes out as "> high". Equal to a limit is not censored. The value is
 *  compared against the limit as stored, so equality stays exact. An uncensored
 *  value is returned as it was. */
export function censorNumeric(v: number, limits: ReportingLimits): CensoredNumeric {
  const { lowLimit, highLimit } = limits;
  if (lowLimit !== null && v < lowLimit) return { value: tidyLimit(lowLimit), comparator: "<" };
  if (highLimit !== null && v > highLimit) return { value: tidyLimit(highLimit), comparator: ">" };
  return { value: v, comparator: null };
}
