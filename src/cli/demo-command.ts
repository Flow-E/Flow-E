import { join } from 'node:path';
import { DEMO_STORY, demoPrompt } from '../demo/content.js';
import {
  claudeCodeCommand,
  claudeDesktopJson,
  cliLauncher,
  shellQuote,
  type DemoSetup,
  type ServeCommand,
} from '../demo/setup.js';

/** The text `flow-e demo` prints: how to connect Claude, where the panel is, what to paste. */
export function demoInstructions(
  setup: DemoSetup,
  serve: ServeCommand,
  panelUrl: string | null,
): string {
  const rule = '─'.repeat(72);
  const cli = `${cliLauncher(serve)} --home ${shellQuote(setup.home)} --config ${shellQuote(setup.configPath)}`;
  return [
    `Flow-E demo ready in ${setup.dir}`,
    'Everything in it is fictional: the company, the people, the suppliers and the prices.',
    'No money moves. Payments are only authorized and recorded.',
    '',
    '1. Connect Claude to the demo agent "lab-procurement" (pick one):',
    '',
    '   Claude Code: run this once, then start "claude" in the same folder:',
    '',
    `   ${claudeCodeCommand(serve)}`,
    '',
    '   Claude Desktop: add this to claude_desktop_config.json, then restart the app:',
    '',
    claudeDesktopJson(serve)
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n'),
    '',
    panelUrl
      ? `2. Open the control panel (the link holds your access token, so keep it private):\n\n   ${panelUrl}`
      : `2. Control panel not started (--no-panel). Start it with:\n\n   ${cli} panel`,
    '',
    `3. Paste this prompt into Claude (also saved to ${join(setup.dir, 'prompt.md')}):`,
    '',
    rule,
    demoPrompt(),
    rule,
    '',
    'What you should see:',
    ...DEMO_STORY.map((line) => `  • ${line}`),
    '',
    'No Claude handy? A fake agent fills the dashboard the same way:',
    '',
    `   ${cliLauncher(serve)} simulate --dir ${shellQuote(setup.dir)}`,
    '',
    'Afterwards, check and export the signed ledger:',
    '',
    `   ${cli} audit`,
    `   ${cli} export --out ledger.csv`,
    '',
    `Start over with: ${cliLauncher(serve)} demo --dir ${shellQuote(setup.dir)} --reset`,
  ].join('\n');
}
