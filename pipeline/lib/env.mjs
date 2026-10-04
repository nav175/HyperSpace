import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The whole team shares one .env.local at the repo root. Next.js loads it on its own; the pipeline
// scripts run outside Next.js, so they load it here.
export const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local');

if (!process.env.NEXT_RUNTIME && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

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
