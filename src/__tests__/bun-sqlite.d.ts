declare module "bun:sqlite" {
  type SqlValue = string | number | bigint | boolean | null | Uint8Array;

  /** Bun's synchronous SQLite query interface used by adapter tests. */
  export interface Query {
    all: (...values: SqlValue[]) => Record<string, SqlValue>[];
    get: (...values: SqlValue[]) => Record<string, SqlValue> | null;
    run: (...values: SqlValue[]) => { readonly changes: number };
  }

  /** In-memory Bun SQLite database handle for D1 repository tests. */
  export class Database {
    /** Open a database at the given filename. */
    constructor(filename: string);

    /** Close the database connection. */
    close(): void;
    /** Execute one or more SQL statements. */
    exec(query: string): void;
    /** Prepare a SQL query for execution. */
    query(query: string): Query;
  }
}
