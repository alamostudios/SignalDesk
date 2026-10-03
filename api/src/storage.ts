import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export type MaterializedObject = { path: string; cleanup: () => Promise<void> };

export interface StorageAdapter {
  putBuffer(key: string, data: Buffer): Promise<void>;
  putStream(key: string, data: Readable): Promise<void>;
  putFile(key: string, localPath: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  stream(key: string): Readable;
  materialize(key: string): Promise<MaterializedObject>;
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(root = process.env.STORAGE_DIR ?? './storage') {
    const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
    this.root = resolve(projectRoot, root);
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    await this.ensureRoot();
    await writeFile(this.pathFor(key), data, { mode: 0o600, flag: 'wx' });
  }

  async putStream(key: string, data: Readable): Promise<void> {
    await this.ensureRoot();
    await pipeline(data, createWriteStream(this.pathFor(key), { mode: 0o600, flags: 'wx' }));
  }

  async putFile(key: string, localPath: string): Promise<void> {
    await this.ensureRoot();
    const target = this.pathFor(key);
    await copyFile(localPath, target);
    await chmod(target, 0o600);
  }

  read(key: string): Promise<Buffer> { return readFile(this.pathFor(key)); }
  stream(key: string): Readable { return createReadStream(this.pathFor(key)); }
  async materialize(key: string): Promise<MaterializedObject> { return { path: this.pathFor(key), cleanup: async () => undefined }; }

  private async ensureRoot() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  private pathFor(key: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error('Invalid storage key');
    return join(this.root, key);
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();