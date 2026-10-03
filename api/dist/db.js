import { PGlite } from '@electric-sql/pglite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const databaseDirectory = resolve(projectRoot, process.env.DATA_DIR ?? './data');
export const database = new PGlite(databaseDirectory);
export const ready = database.waitReady;
export async function query(text, values = []) {
    await ready;
    const result = await database.query(text, values);
    return { ...result, rowCount: result.rowCount ?? result.rows.length };
}
export async function transaction(callback) {
    await ready;
    return database.transaction(async (nativeTx) => callback({
        query: async (text, values = []) => {
            const result = await nativeTx.query(text, values);
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        },
        exec: async (text) => nativeTx.exec(text)
    }));
}
export async function closeDatabase() {
    await database.close();
}
export async function audit(userId, action, incidentId, details = {}) {
    await query('INSERT INTO audit_log(user_id, action, incident_id, details) VALUES ($1,$2,$3,$4)', [userId, action, incidentId, details]);
}
