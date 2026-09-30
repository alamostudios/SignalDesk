import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 15, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) => pool.query<T>(text, values);

export async function audit(userId: string | null, action: string, incidentId: string | null, details: Record<string, unknown> = {}) {
  await query('INSERT INTO audit_log(user_id, action, incident_id, details) VALUES ($1,$2,$3,$4)', [userId, action, incidentId, details]);
}