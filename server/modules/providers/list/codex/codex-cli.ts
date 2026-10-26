import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

/**
 * The `codex` CLI that CloudCLI runs: turns, forks and the model list all go
 * through the same one.
 *
 * It is the newest of the CLIs on PATH and the one in node_modules. OpenAI
 * serves the model catalog per client version and leaves out models the
 * client is too old for: on 2026-10-26 the bundled 0.156.1 got no
 * `gpt-6.1-sol`, while the 0.163.0 on PATH did. The bundled CLI only moves
 * when CloudCLI is rebuilt. The one on PATH is the one the user keeps current
 * for the terminal, so it wins whenever it is newer. Older PATH installs are
 * ignored.
 */
export type CodexCli = {
  /** Path to spawn, or `null` for the bundled CLI, which the SDK locates itself. */
  executable: string | null;
  version: string;
};

/** A CLI upgrade is picked up within this long. */
const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;

const require_ = createRequire(import.meta.url);

const parseVersion = (text: string): number[] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
};

/** Exported for tests. True when version `a` is strictly newer than `b`. */
export const isNewerCodexVersion = (a: string, b: string): boolean => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return false;
};

const findCodexesOnPath = async (): Promise<string[]> => {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const found: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      found.push(candidate);
    } catch {
      // Not in this directory.
    }
  }
  return found;
};

const readPathCodexVersion = async (executable: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: VERSION_TIMEOUT_MS });
    const version = parseVersion(stdout);
    return version ? version.join('.') : null;
  } catch {
    return null;
  }
};

const resolveUncached = async (): Promise<CodexCli> => {
  const bundledVersion = (require_('@openai/codex/package.json') as { version: string }).version;
  let best: CodexCli = { executable: null, version: bundledVersion };
  // Every PATH entry, not just the first: `npx` and npm scripts put this
  // package's own node_modules/.bin, which is the bundled CLI, in front.
  for (const executable of await findCodexesOnPath()) {
    const version = await readPathCodexVersion(executable);
    if (version && isNewerCodexVersion(version, best.version)) {
      best = { executable, version };
    }
  }
  return best;
};

let cached: { cli: Promise<CodexCli>; resolvedAt: number } | null = null;

export const resolveCodexCli = (): Promise<CodexCli> => {
  if (!cached || Date.now() - cached.resolvedAt > RESOLUTION_TTL_MS) {
    const cli = resolveUncached();
    cached = { cli, resolvedAt: Date.now() };
    // A failed lookup is not kept: the next call tries again.
    cli.catch(() => {
      cached = null;
    });
  }
  return cached.cli;
};

/** Command line that runs `args` on `cli`. The bundled CLI goes through its node launcher. */
export const codexCommand = (cli: CodexCli, args: string[]): { command: string; args: string[] } => {
  if (cli.executable) {
    return { command: cli.executable, args };
  }

  let launcher: string;
  try {
    launcher = require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
  return { command: process.execPath, args: [launcher, ...args] };
};
