import './env.js';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { closeDatabase, query, transaction } from './db.js';
export async function runMigrations() {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for (const name of files) {
        const wasApplied = await transaction(async (tx) => {
            const applied = await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [name]);
            if (applied.rowCount)
                return false;
            await tx.exec(await readFile(join(directory, name), 'utf8'));
            await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
            return true;
        });
        if (wasApplied)
            console.info(`Applied migration ${name}`);
    }
    console.info('Database migrations complete');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        await runMigrations();
    }
    finally {
        await closeDatabase();
    }
}
