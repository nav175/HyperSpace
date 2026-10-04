import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The whole team shares one .env.local at the repo root, the same file Next.js reads.
export const ENV_FILE = fileURLToPath(new URL('../../.env.local', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export function missingEnv(...names) {
  return names.filter((name) => !process.env[name]?.trim());
}

export function requireEnv(...names) {
  const missing = missingEnv(...names);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in .env.local (template: .env.example)`);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name].trim()]));
}
