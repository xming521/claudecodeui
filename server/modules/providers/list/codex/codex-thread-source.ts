import os from 'node:os';
import path from 'node:path';
import { open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

/**
 * Makes CloudCLI's Codex threads show up in the Codex app and `codex resume`.
 *
 * The SDK runs every turn through `codex exec`, which records the thread with
 * `source: "exec"` in the rollout's first `session_meta` line. Codex's thread
 * list (app-server `thread/list`, the desktop app, the TUI picker) only shows
 * interactive sources by default, so these threads were invisible there. The
 * rollout line is what the list reads; Codex's state DB follows it on the next
 * read. Later `codex exec resume` runs append to the file and leave the first
 * line alone, so one rewrite per thread is enough.
 *
 * `vscode` rather than `cli`: it is the source the desktop app gives its own
 * threads, so the app is certain to list it, and the TUI's default filter
 * includes it too.
 */

const INTERACTIVE_SOURCE = 'vscode';
const EXEC_SOURCE_FIELD = '"source":"exec"';
const INTERACTIVE_SOURCE_FIELD = `"source":"${INTERACTIVE_SOURCE}"`;
/** session_meta carries the base instructions, so the first line can be long. */
const HEAD_READ_BYTES = 256 * 1024;

const defaultSessionsRoot = () => path.join(os.homedir(), '.codex', 'sessions');

/**
 * Finds `rollout-<timestamp>-<threadId>.jsonl` under the date-partitioned
 * sessions tree, newest directories first so a thread that just ran is found
 * after a few directory reads.
 */
async function findRollout(directory: string, suffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const file = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (file) {
    return path.join(directory, file.name);
  }

  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of subdirectories) {
    const match = await findRollout(path.join(directory, name), suffix);
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * Rewrites the thread's `session_meta` source from `exec` to an interactive
 * one. Returns true when the file was changed.
 *
 * Call only after the `codex exec` process has exited: the file is replaced
 * through a rename, so a writer still holding the old file would lose its
 * appends. Anything unexpected (no rollout, a first line that is not exec
 * session_meta, an ambiguous match) leaves the file untouched.
 */
export async function markCodexThreadInteractive(
  threadId: string,
  sessionsRoot: string = defaultSessionsRoot(),
): Promise<boolean> {
  const rolloutPath = await findRollout(sessionsRoot, `-${threadId}.jsonl`);
  if (!rolloutPath) {
    return false;
  }

  const handle = await open(rolloutPath, 'r');
  let head: string;
  try {
    const buffer = Buffer.alloc(HEAD_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_READ_BYTES, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }

  const newline = head.indexOf('\n');
  if (newline === -1) {
    return false;
  }
  const firstLine = head.slice(0, newline);
  let meta;
  try {
    meta = JSON.parse(firstLine);
  } catch {
    return false;
  }
  if (meta?.type !== 'session_meta' || meta.payload?.source !== 'exec') {
    return false;
  }
  // The field appears once at the payload level; inside string values its
  // quotes would be escaped and not match.
  if (firstLine.split(EXEC_SOURCE_FIELD).length !== 2) {
    return false;
  }
  const patchedLine = firstLine.replace(EXEC_SOURCE_FIELD, INTERACTIVE_SOURCE_FIELD);
  if (JSON.parse(patchedLine).payload?.source !== INTERACTIVE_SOURCE) {
    return false;
  }

  const content = await readFile(rolloutPath);
  const firstLineBytes = Buffer.byteLength(firstLine, 'utf8');
  const { mode } = await stat(rolloutPath);
  const temporaryPath = `${rolloutPath}.cloudcli-tmp`;
  await writeFile(
    temporaryPath,
    Buffer.concat([Buffer.from(patchedLine, 'utf8'), content.subarray(firstLineBytes)]),
    { mode },
  );
  await rename(temporaryPath, rolloutPath);
  return true;
}
