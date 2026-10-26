import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { CodexModel } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { isNewerCodexVersion } from '@/modules/providers/list/codex/codex-cli.js';
import {
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
  toCodexModelsDefinition,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

const cliModel = (model: string, overrides: Partial<CodexModel> = {}): CodexModel => ({
  model,
  displayName: model.toUpperCase(),
  description: `${model} description`,
  isDefault: false,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast' },
    { reasoningEffort: 'medium' },
  ],
  ...overrides,
});

test('turns the CLI model list into a catalog in the CLI order, defaulting to its default model', () => {
  const definition = toCodexModelsDefinition([
    cliModel('gpt-6.1-sol', { isDefault: true, defaultReasoningEffort: 'low' }),
    cliModel('gpt-6-astra', { supportedReasoningEfforts: [] }),
  ]);

  assert.deepEqual(definition, {
    OPTIONS: [
      {
        value: 'gpt-6.1-sol',
        label: 'GPT-6.1-SOL',
        description: 'gpt-6.1-sol description',
        effort: {
          default: 'low',
          values: [{ value: 'low', description: 'Fast' }, { value: 'medium' }],
        },
      },
      { value: 'gpt-6-astra', label: 'GPT-6-ASTRA', description: 'gpt-6-astra description' },
    ],
    DEFAULT: 'gpt-6.1-sol',
  });
  assert.equal(toCodexModelsDefinition([cliModel('a'), cliModel('b')])?.DEFAULT, 'a');
  assert.equal(toCodexModelsDefinition([]), null);
});

test('serves the CLI list, and the curated list only while the CLI cannot be read', async () => {
  let calls = 0;
  const listed = new CodexProviderModels(async () => {
    calls += 1;
    return [cliModel('gpt-6.1-sol', { isDefault: true })];
  });
  const first = await listed.getSupportedModels();
  assert.deepEqual(first.OPTIONS.map((option) => option.value), ['gpt-6.1-sol']);
  await listed.getSupportedModels();
  assert.equal(calls, 1, 'a fresh list is not read again');

  const broken = new CodexProviderModels(async () => {
    throw new Error('app-server exited');
  });
  assert.equal(await broken.getSupportedModels(), CODEX_PREDEFINED_MODELS);
  const empty = new CodexProviderModels(async () => []);
  assert.equal(await empty.getSupportedModels(), CODEX_PREDEFINED_MODELS);
});

test('compares Codex CLI versions numerically', () => {
  assert.equal(isNewerCodexVersion('0.163.0', '0.156.1'), true);
  assert.equal(isNewerCodexVersion('codex-cli 0.163.0', '0.163.0'), false);
  assert.equal(isNewerCodexVersion('0.99.0', '0.156.1'), false);
  assert.equal(isNewerCodexVersion('1.0.0', '0.200.3'), true);
  assert.equal(isNewerCodexVersion('unknown', '0.156.1'), false);
});
