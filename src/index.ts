import { runCli } from '@llm-runtime-dock/cli';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { createLmStudioAdapter } from '@llm-runtime-dock/adapter-lm-studio';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import { createOmlxAdapter } from '@llm-runtime-dock/adapter-omlx';
import { createOllamaAdapter } from '@llm-runtime-dock/adapter-ollama';
import { createClaudeIntegration } from '@llm-runtime-dock/agent-claude';
import { createCodexIntegration } from '@llm-runtime-dock/agent-codex';
import { createOpenCodeIntegration } from '@llm-runtime-dock/agent-opencode';
import type { AgentIntegration, Logger, RuntimeAdapter } from '@llm-runtime-dock/core';

/**
 * The composition root.
 *
 * This is the only place that imports concrete adapters and agent integrations,
 * which is exactly what keeps `@llm-runtime-dock/core` free of them (spec §6).
 */

export const defaultAdapters = (logger?: Logger): RuntimeAdapter[] => {
  return [
    createMtplxAdapter(logger ? { logger } : {}),
    createLmStudioAdapter(logger ? { logger } : {}),
    createOmlxAdapter(logger ? { logger } : {}),
    createOllamaAdapter(logger ? { logger } : {}),
    createCustomAdapter(logger ? { logger } : {}),
  ];
};

export const defaultAgents = (): AgentIntegration[] => {
  return [createOpenCodeIntegration(), createClaudeIntegration(), createCodexIntegration()];
};

export const main = async (argv: readonly string[] = process.argv): Promise<void> => {
  const code = await runCli({
    argv: stripArgSeparator(argv.slice(2)),
    adapters: defaultAdapters(),
    agents: defaultAgents(),
    version: __LRD_VERSION__,
  });
  if (code !== 0) process.exit(code);
};

/**
 * `pnpm dev -- probe --help` forwards the literal `--` into argv. Left in place
 * it would make everything after it a positional operand, so `--help` would be
 * read as a command name. No `lrd` command takes free-form trailing arguments,
 * so dropping one leading separator is safe and makes both spellings work.
 */
const stripArgSeparator = (args: readonly string[]): string[] => {
  return args[0] === '--' ? args.slice(1) : [...args];
};

export { runCli };
