import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeModelCommandOutput } from '@/modules/providers/list/claude/claude-model-resolution.js';
import {
  applyClaudeModelResolutions,
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
  extractClaudeEventModel,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

// Replies of the CLI's local `/model` command (Claude Code 2.1.302).
const MODEL_COMMAND_USAGE = ' Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, default, or a full model ID.';

test('reads the model and default effort from the /model reply', () => {
  assert.deepEqual(
    parseClaudeModelCommandOutput(`Current model: \`Opus 5.5\` (effort: xhigh)${MODEL_COMMAND_USAGE}`),
    { label: 'Opus 5.5', effort: 'xhigh' },
  );
  assert.deepEqual(
    parseClaudeModelCommandOutput(`Current model: \`Opus 5.5 (1M context)\` (effort: xhigh)${MODEL_COMMAND_USAGE}`),
    { label: 'Opus 5.5 (1M context)', effort: 'xhigh' },
  );
  // Haiku has no effort levels, so the CLI names none.
  assert.deepEqual(
    parseClaudeModelCommandOutput(`Current model: \`Haiku 5.5\`${MODEL_COMMAND_USAGE}`),
    { label: 'Haiku 5.5' },
  );
  assert.equal(parseClaudeModelCommandOutput('Unknown command: /model'), null);
});

const RESOLVED = new Map([
  ['default', { label: 'Opus 5.5', effort: 'xhigh' }],
  ['best', { label: 'Fable 5.1', effort: 'high' }],
  ['fable', { label: 'Fable 5.1', effort: 'high' }],
  ['opus', { label: 'Opus 5.5', effort: 'xhigh' }],
  ['haiku', { label: 'Haiku 5.5' }],
]);

const findOption = (definition: typeof CLAUDE_PREDEFINED_MODELS, value: string) => {
  const option = definition.OPTIONS.find((candidate) => candidate.value === value);
  assert.ok(option, value);
  return option;
};

test('labels each alias with the model it runs and the level it defaults to', () => {
  const definition = applyClaudeModelResolutions(CLAUDE_PREDEFINED_MODELS, RESOLVED);

  const defaultOption = findOption(definition, 'default');
  assert.equal(defaultOption.label, 'Default (recommended)');
  assert.equal(defaultOption.resolvedLabel, 'Opus 5.5');
  assert.equal(defaultOption.resolvedEffort, 'xhigh');
  // `default` runs Opus here, so it offers Opus's levels, xhigh included.
  assert.deepEqual(defaultOption.effort, findOption(CLAUDE_PREDEFINED_MODELS, 'opus').effort);

  assert.equal(findOption(definition, 'best').resolvedLabel, 'Fable 5.1');
  const haiku = findOption(definition, 'haiku');
  assert.equal(haiku.resolvedLabel, 'Haiku 5.5');
  assert.equal(haiku.resolvedEffort, undefined);

  // Not resolved: left exactly as the catalog has it.
  assert.deepEqual(findOption(definition, 'sonnet'), findOption(CLAUDE_PREDEFINED_MODELS, 'sonnet'));
});

test('default takes no effort levels when it lands on Haiku', () => {
  const definition = applyClaudeModelResolutions(
    CLAUDE_PREDEFINED_MODELS,
    new Map([['default', { label: 'Haiku 5.5' }], ['haiku', { label: 'Haiku 5.5' }]]),
  );

  assert.equal(findOption(definition, 'default').effort, undefined);
});

test('resolves once, serves the cache, and refreshes in the background when settings change', async () => {
  const calls: string[] = [];
  let fingerprint = 'settings-v1';
  let effort = 'xhigh';
  const models = new ClaudeProviderModels(
    async (model) => {
      calls.push(model);
      return model === 'default' ? { label: 'Opus 5.5', effort } : null;
    },
    async () => fingerprint,
  );

  // The constructor's warm-up and this first request share one round.
  const first = await models.getSupportedModels();
  assert.equal(findOption(first, 'default').resolvedEffort, 'xhigh');
  const roundSize = CLAUDE_PREDEFINED_MODELS.OPTIONS.length;
  assert.equal(calls.length, roundSize);

  await models.getSupportedModels();
  assert.equal(calls.length, roundSize);

  fingerprint = 'settings-v2';
  effort = 'high';
  const stale = await models.getSupportedModels();
  assert.equal(findOption(stale, 'default').resolvedEffort, 'xhigh');

  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await models.getSupportedModels();
  assert.equal(findOption(fresh, 'default').resolvedEffort, 'high');
  assert.equal(calls.length, roundSize * 2);
});

test('a CLI that cannot answer leaves the catalog as is and is not retried per request', async () => {
  let calls = 0;
  const models = new ClaudeProviderModels(
    async () => {
      calls += 1;
      throw new Error('not logged in');
    },
    async () => 'settings',
  );

  assert.deepEqual(await models.getSupportedModels(), CLAUDE_PREDEFINED_MODELS);
  await models.getSupportedModels();
  assert.equal(calls, CLAUDE_PREDEFINED_MODELS.OPTIONS.length);
});
