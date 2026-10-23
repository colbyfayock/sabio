import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class LocalStatement {
  constructor(database, query, values = []) { this.database = database; this.query = query; this.values = values; }
  bind(...values) { return new LocalStatement(this.database, this.query, values); }
  async first(columnName) {
    this.database.counters.queries += 1;
    const [row] = this.database.sqlite.prepare(this.query).all(...this.values);
    return row ? columnName ? row[columnName] : row : null;
  }
  async all() {
    this.database.counters.queries += 1;
    return { results: this.database.sqlite.prepare(this.query).all(...this.values) };
  }
  async run() {
    this.database.counters.queries += 1;
    this.database.sqlite.prepare(this.query).run(...this.values);
    return { success: true };
  }
}

/** Test adapter: execute the real schema and SQL with atomic D1-style batches. */
export class LocalD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    // Regression instrumentation: counts every statement the Worker asks D1 to run.
    // Direct db.sqlite access in tests bypasses these counters on purpose.
    this.counters = { batches: 0, statements: 0, queries: 0 };
    const directory = new URL('../../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
  }
  prepare(query) { return new LocalStatement(this, query); }
  async batch(statements) {
    this.counters.batches += 1;
    this.counters.statements += statements.length;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => ({ results: this.sqlite.prepare(statement.query).all(...statement.values) }));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  /** Snapshot counters so tests can assert bounded work across a request batch. */
  stats() { return { ...this.counters }; }
  close() { this.sqlite.close(); }
}
