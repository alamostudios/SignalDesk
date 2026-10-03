import { PGlite, type Transaction } from '@electric-sql/pglite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const databaseDirectory = resolve(projectRoot, process.env.DATA_DIR ?? './data');
export const database = new PGlite(databaseDirectory);
export const ready = database.waitReady;

export type DatabaseResult<T extends Record<string, any> = Record<string, any>> = { rows: T[]; rowCount: number };
export type DatabaseTransaction = {
  query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<DatabaseResult<T>>;
  exec(text: string): Promise<unknown>;
};

export async function query<T extends Record<string, any> = Record<string, any>>(text: string, values: unknown[] = []): Promise<DatabaseResult<T>> {
  await ready;
  const result = await database.query<T>(text, values);
  return { ...result, rowCount: result.rowCount ?? result.rows.length };
}

export async function transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  await ready;
  return database.transaction(async (nativeTx: Transaction) => callback({
    query: async <R extends Record<string, any> = Record<string, any>>(text: string, values: unknown[] = []) => {
      const result = await nativeTx.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    exec: async (text: string) => nativeTx.exec(text)
  }));
}

export async function closeDatabase(): Promise<void> {
  await database.close();
}

export async function audit(userId: string | null, action: string, incidentId: string | null, details: Record<string, unknown> = {}) {
  await query('INSERT INTO audit_log(user_id, action, incident_id, details) VALUES ($1,$2,$3,$4)', [userId, action, incidentId, details]);
}