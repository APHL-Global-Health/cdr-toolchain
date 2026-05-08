export const ERROR_CODES = {
  USAGE: { code: "USAGE", exit: 2, description: "Invalid arguments or usage" },
  UNKNOWN_ENTITY: {
    code: "UNKNOWN_ENTITY",
    exit: 2,
    description: "Entity alias or table name not recognized",
  },
  MISSING_FLAG: {
    code: "MISSING_FLAG",
    exit: 2,
    description: "A required flag was not provided",
  },
  CONFIG_MISSING: {
    code: "CONFIG_MISSING",
    exit: 3,
    description: "Connection string not configured (flag, env var, or .env)",
  },
  CONFIG_INVALID: {
    code: "CONFIG_INVALID",
    exit: 3,
    description: "Config value failed validation",
  },
  ENV_FILE_UNREADABLE: {
    code: "ENV_FILE_UNREADABLE",
    exit: 3,
    description: "Specified --env-file path could not be read",
  },
  DB_CONNECT_FAILED: {
    code: "DB_CONNECT_FAILED",
    exit: 4,
    description: "Could not connect to the database",
  },
  DB_QUERY_FAILED: {
    code: "DB_QUERY_FAILED",
    exit: 4,
    description: "Database returned an error while executing the query",
  },
  GET_MULTIPLE_ROWS: {
    code: "GET_MULTIPLE_ROWS",
    exit: 6,
    description: "`get` expected a single row but the query matched multiple",
  },
  GET_NO_ROWS: {
    code: "GET_NO_ROWS",
    exit: 6,
    description: "`get` expected a single row but the query matched none",
  },
  NOT_SUPPORTED: {
    code: "NOT_SUPPORTED",
    exit: 2,
    description: "Requested operation not supported for this entity",
  },
  OPENLDR_CONFIG_MISSING: {
    code: "OPENLDR_CONFIG_MISSING",
    exit: 3,
    description: "OpenLDR v1 connection string not configured (set OPENLDR_V1_CONNECTION_STRING or use --openldr-cs)",
  },
  MISMATCH: {
    code: "MISMATCH",
    exit: 7,
    description: "`compare` found at least one field that differs or is present on only one side",
  },
  NOT_IMPLEMENTED: {
    code: "NOT_IMPLEMENTED",
    exit: 8,
    description: "Requested capability is recognised but not yet implemented",
  },
  API_CONFIG_MISSING: {
    code: "API_CONFIG_MISSING",
    exit: 3,
    description: "OpenLDR v2 API URL or auth token not configured (set OPENLDR_V2_URL and OPENLDR_V2_TOKEN, or use --target-api / --token)",
  },
  API_REJECTED: {
    code: "API_REJECTED",
    exit: 9,
    description: "OpenLDR v2 API rejected the payload (4xx response, excluding 429)",
  },
  API_UNAVAILABLE: {
    code: "API_UNAVAILABLE",
    exit: 10,
    description: "OpenLDR v2 API unreachable or returned 5xx after retries",
  },
  QUARANTINED: {
    code: "QUARANTINED",
    exit: 11,
    description: "Lab has data-quality anomalies at or above the quarantine severity threshold; payload written to quarantine path instead of POSTed.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return ERROR_CODES[this.code].exit;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function formatError(err: unknown): { json: string; exitCode: number } {
  if (err instanceof CliError) {
    return { json: JSON.stringify(err.toJSON()), exitCode: err.exitCode };
  }
  const message = err instanceof Error ? err.message : String(err);
  const payload = {
    error: {
      code: "UNKNOWN",
      message,
    },
  };
  return { json: JSON.stringify(payload), exitCode: 1 };
}
