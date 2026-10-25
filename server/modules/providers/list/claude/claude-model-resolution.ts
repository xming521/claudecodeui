import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

/** What one catalog alias stands for under the user's current Claude Code setup. */
export type ClaudeResolvedModel = {
  /** The CLI's own name for the model, e.g. `Opus 5.5` or `Opus 5.5 (1M context)`. */
  label: string;
  /** The effort a turn runs at when CloudCLI sends none; absent for models without effort. */
  effort?: string;
};

export type ClaudeModelResolver = (model: string) => Promise<ClaudeResolvedModel | null>;

const CURRENT_MODEL_PATTERN = /Current model: `([^`]+)`(?: \(effort: ([a-z]+)\))?/;
const RESOLVE_TIMEOUT_MS = 20_000;

/** Exported for tests. Reads the first line of the CLI's `/model` reply. */
export const parseClaudeModelCommandOutput = (text: string): ClaudeResolvedModel | null => {
  const match = CURRENT_MODEL_PATTERN.exec(text);
  const label = match?.[1]?.trim();
  if (!label) {
    return null;
  }

  return match?.[2] ? { label, effort: match[2] } : { label };
};

/**
 * Asks Claude Code what `model` resolves to by running its `/model` command
 * with that model selected. `/model` is a local command: it makes no model
 * call and costs nothing, and `persistSession: false` keeps it out of the
 * session list. Settings load the way a real turn loads them, so the answer
 * includes the user's `model` and per-model `effortLevel` overrides.
 */
export const resolveClaudeModelWithCli: ClaudeModelResolver = async (model) => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), RESOLVE_TIMEOUT_MS);
  const run = query({
    prompt: '/model',
    options: {
      model,
      abortController,
      cwd: os.homedir(),
      env: { ...process.env },
      maxTurns: 1,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
      persistSession: false,
      settingSources: ['project', 'user', 'local'],
      // The user's Stop hooks are meant for their own turns, not for this lookup.
      settings: { disableAllHooks: true },
    },
  });

  try {
    for await (const message of run) {
      if (message.type === 'result') {
        return message.subtype === 'success' ? parseClaudeModelCommandOutput(message.result) : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    run.close();
  }
};

const readMtime = async (filePath: string | undefined): Promise<string> => {
  if (!filePath) {
    return '-';
  }

  try {
    return String((await stat(filePath)).mtimeMs);
  } catch {
    return '-';
  }
};

/** The CLI file the SDK will run: a configured path as is, a bare command looked up on PATH. */
const readCliMtime = async (): Promise<string> => {
  const command = resolveClaudeCodeExecutablePath();
  if (!command || command.includes('/') || command.includes('\\')) {
    return readMtime(command);
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const mtime = await readMtime(path.join(dir, command));
    if (mtime !== '-') {
      return mtime;
    }
  }
  return '-';
};

/**
 * Changes whenever an input to the answer changes: the user's settings files
 * or the CLI binary. Account changes (a plan upgrade) are left to the TTL.
 */
export const readClaudeModelSetupFingerprint = async (): Promise<string> => {
  const claudeDir = path.join(os.homedir(), '.claude');
  const parts = await Promise.all([
    readMtime(path.join(claudeDir, 'settings.json')),
    readMtime(path.join(claudeDir, 'settings.local.json')),
    readCliMtime(),
  ]);
  return parts.join('|');
};
