/**
 * `@flow-e/mcp/core`: the pure half of Flow-E, for other hosts such as the website. Rules,
 * money, crypto, ledger entries and receipts, config validation, owner actions as plans, CSV and
 * the demo content. No file system, no SQLite, no network: test/core.test.ts enforces that.
 */
export * from './engine/index.js';
export { formatClock } from './engine/time.js';
export { canonicalJson } from './crypto/canonical.js';
export {
  generateKeyPair,
  issuerIdFor,
  publicKeyOf,
  signPayload,
  verifyPayload,
  type PemKeyPair,
} from './crypto/ed25519.js';
export * from './ledger/receipt.js';
export * from './ledger/fold.js';
export {
  ConfigError,
  configSchema,
  parseConfig,
  parseConfigObject,
  type AgentConfig,
  type MandateConfig,
  type RawConfig,
} from './config/schema.js';
export {
  CREDENTIAL_DOMAIN,
  CREDENTIAL_FORMAT,
  CredentialError,
  MAX_VALID_DAYS,
  PAYMENT_SCOPE,
  issueCredential,
  parseCredential,
  signatureCheck,
  type CredentialFile,
} from './kya/credential.js';
export * from './control/plan.js';
export * from './tools/agent-tools.js';
export { csvCell, csvFromEntries } from './control/csv.js';
export {
  CATALOG,
  DEMO_AGENT,
  DEMO_CONFIG_YAML,
  DEMO_STORY,
  DEMO_STORY_STEPS,
  catalogTable,
  demoPrompt,
  type CatalogItem,
} from './demo/content.js';
