import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
config({ path: join(projectRoot, '.env'), override: false });

const dataDirectory = resolve(projectRoot, process.env.DATA_DIR ?? './data');
const secretsPath = join(dataDirectory, '.generated-secrets.json');
const adminCredentialsPath = join(dataDirectory, 'initial-admin.txt');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

type GeneratedSettings = Record<string, string>;
let generatedSettings: GeneratedSettings = {};
let settingsChanged = false;
if (existsSync(secretsPath)) {
	try {
		generatedSettings = JSON.parse(readFileSync(secretsPath, 'utf8')) as GeneratedSettings;
	} catch {
		throw new Error(`Could not read generated settings at ${secretsPath}`);
	}
}

function isPlaceholder(value: string) {
	return /^(replace-with|change-this|your[-_ ]|changeme)/i.test(value);
}

function setting(name: string, create: () => string, valid: (value: string) => boolean = value => !isPlaceholder(value)) {
	const configured = process.env[name];
	if (configured && valid(configured)) return { value: configured, generated: false };
	const saved = generatedSettings[name];
	if (saved && valid(saved)) {
		process.env[name] = saved;
		return { value: saved, generated: true };
	}
	const value = create();
	process.env[name] = value;
	generatedSettings[name] = value;
	settingsChanged = true;
	return { value, generated: true };
}

setting('JWT_SECRET', () => randomBytes(48).toString('base64url'));
setting('PUBLIC_AUDIO_SECRET', () => randomBytes(48).toString('base64url'));
setting('INGEST_API_KEY', () => randomBytes(32).toString('base64url'));
const adminEmail = setting('BOOTSTRAP_ADMIN_EMAIL', () => 'admin@localhost');
const adminPassword = setting('BOOTSTRAP_ADMIN_PASSWORD', () => randomBytes(32).toString('base64url'), value => value.length >= 16 && !isPlaceholder(value));
process.env.BOOTSTRAP_ADMIN_PASSWORD_GENERATED = String(adminPassword.generated);

if (settingsChanged) {
	const temporaryPath = `${secretsPath}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(generatedSettings, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, secretsPath);
}

if (adminPassword.generated && !existsSync(adminCredentialsPath)) {
	writeFileSync(adminCredentialsPath, `Email: ${adminEmail.value}\nPassword: ${adminPassword.value}\n`, { mode: 0o600, flag: 'wx' });
}