import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The state directory (issuer keys, credentials, ledger) when nothing else is given. */
export const HOME_DIR = '.mandate';
/** The state directory made before the rename to Mandate. Still used when it is the only one. */
export const LEGACY_HOME_DIR = '.flow-e';

type Env = Record<string, string | undefined>;

/**
 * --home default: MANDATE_HOME, then the pre-rename FLOWE_HOME, then `.mandate`. A project that
 * only has a `.flow-e` folder keeps using it, so its keys and ledger are never orphaned.
 */
export function defaultHome(
  env: Env = process.env,
  cwd: string = process.cwd(),
  exists: (path: string) => boolean = existsSync,
): string {
  const fromEnv = env.MANDATE_HOME ?? env.FLOWE_HOME;
  if (fromEnv) return fromEnv;
  if (!exists(join(cwd, HOME_DIR)) && exists(join(cwd, LEGACY_HOME_DIR))) return LEGACY_HOME_DIR;
  return HOME_DIR;
}

/** --config default: MANDATE_CONFIG, then the pre-rename FLOWE_CONFIG, then `mandate.yaml`. */
export function defaultConfig(env: Env = process.env): string {
  return env.MANDATE_CONFIG ?? env.FLOWE_CONFIG ?? 'mandate.yaml';
}
