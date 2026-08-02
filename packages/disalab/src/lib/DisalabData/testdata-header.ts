import * as Core from "../core.js";
import type { DisaInput } from "../core.js";

/**
 * TESTDATA_STATUS is a fixed 80-byte header followed by the result payload.
 * TESTDATA.ts has always parsed from offset 80 onward; bytes 0-79 were never
 * decoded, which is why the review signal sat unread in every row.
 */
export const HEADER_LENGTH = 80;

export interface HeaderOffsets {
  /** `end` is EXCLUSIVE. Reviewer initials, ASCII. */
  reviewerInitials: { start: number; end: number };
}

/**
 * Tanzania (TDS) measured default. Other deployments MUST re-measure — DISA
 * versions vary even within one database. See config/<country>.yaml.
 */
export const DEFAULT_HEADER_OFFSETS: HeaderOffsets = {
  reviewerInitials: { start: 77, end: 80 },
};

function readInitials(raw: string, slot: { start: number; end: number }): string | null {
  const slice = Core.FixString(raw, slot.start, slot.end);
  let out = "";
  for (let i = 0; i < slice.length; i++) {
    const b = slice.charCodeAt(i) & 0xff;
    if (b === 0) continue;
    out += String.fromCharCode(b);
  }
  const trimmed = out.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class TestDataHeader {
  /** latin1 string — charCodeAt(i) & 0xff is byte i. Length <= HEADER_LENGTH. */
  readonly raw: string;

  private constructor(raw: string) {
    this.raw = raw;
  }

  /** Preferred entry point when the caller has already decoded the blob. */
  static fromDecoded(data: string): TestDataHeader {
    return new TestDataHeader(Core.FixString(data, 0, HEADER_LENGTH));
  }

  static fromBytes(bytes: DisaInput): TestDataHeader {
    return TestDataHeader.fromDecoded(Core.ConvertToBytes(bytes));
  }

  /**
   * Reviewer initials from an EXPLICIT slot. Non-null ⇒ reviewed.
   *
   * ⛔ Offsets are a PARAMETER, never baked in at construction. TESTDATA builds
   * headers deep inside disalab, with no access to config/<country>.yaml — so a
   * header that decoded initials in its constructor could only ever use the
   * hardcoded default, silently making the YAML inert. Applying the slot at
   * READ time is what lets configured offsets actually reach the decode.
   */
  initialsAt(slot: { start: number; end: number }): string | null {
    return readInitials(this.raw, slot);
  }

  /** Raw byte at `index`, or 0 past the end. Used by the Phase 1 search. */
  byteAt(index: number): number {
    return index < this.raw.length ? this.raw.charCodeAt(index) & 0xff : 0;
  }
}
