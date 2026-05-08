export interface DisaServer {
  config: {
    database: {
      driver: string;
      connection_string: string;
    };
  };
}

export type DisaBytes = string | Buffer | null | undefined;
