/**
 * The site's own settings are named MANDATE_<NAME>. Deployments made before the rename to Mandate
 * set FLOWE_<NAME>; that older name is still read when the new one is not set, so an existing
 * deployment keeps working until its environment is renamed.
 */
export function mandateEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MANDATE_${name}`] ?? env[`FLOWE_${name}`];
}
