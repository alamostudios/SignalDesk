import pg from 'pg';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 15, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
export const query = (text, values = []) => pool.query(text, values);
export async function audit(userId, action, incidentId, details = {}) {
    await query('INSERT INTO audit_log(user_id, action, incident_id, details) VALUES ($1,$2,$3,$4)', [userId, action, incidentId, details]);
}
