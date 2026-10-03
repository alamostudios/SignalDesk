import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
export class LocalStorageAdapter {
    root;
    constructor(root = process.env.STORAGE_DIR ?? './storage') {
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        this.root = resolve(projectRoot, root);
    }
    async putBuffer(key, data) {
        await this.ensureRoot();
        await writeFile(this.pathFor(key), data, { mode: 0o600, flag: 'wx' });
    }
    async putStream(key, data) {
        await this.ensureRoot();
        await pipeline(data, createWriteStream(this.pathFor(key), { mode: 0o600, flags: 'wx' }));
    }
    async putFile(key, localPath) {
        await this.ensureRoot();
        const target = this.pathFor(key);
        await copyFile(localPath, target);
        await chmod(target, 0o600);
    }
    read(key) { return readFile(this.pathFor(key)); }
    stream(key) { return createReadStream(this.pathFor(key)); }
    async materialize(key) { return { path: this.pathFor(key), cleanup: async () => undefined }; }
    async ensureRoot() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
    pathFor(key) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key))
            throw new Error('Invalid storage key');
        return join(this.root, key);
    }
}
export const storage = new LocalStorageAdapter();
