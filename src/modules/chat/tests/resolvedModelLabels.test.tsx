import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { formatModelOptionHint, formatModelOptionLabel } from '@/modules/chat/utils/modelLabel';
import type { ProviderModelOption } from '@/shared/types';

/**
 * Claude's catalog is made of aliases ("Default (recommended)", "Sonnet").
 * Once the server has resolved them, the pickers name the model each one runs
 * and the level a "default" effort stands for.
 */

const EFFORT_VALUES = [{ value: 'high' }, { value: 'xhigh' }];

const OPTIONS: ProviderModelOption[] = [
  {
    value: 'default',
    label: 'Default (recommended)',
    resolvedLabel: 'Opus 5.5',
    resolvedEffort: 'xhigh',
    effort: { values: EFFORT_VALUES },
  },
  { value: 'sonnet', label: 'Sonnet', resolvedLabel: 'Sonnet 5.5', resolvedEffort: 'high', effort: { values: EFFORT_VALUES } },
  { value: 'sonnet[1m]', label: 'Sonnet (1M context)', resolvedLabel: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku' },
];

test('the catalog label stays as a hint only where it adds something', () => {
  assert.equal(formatModelOptionLabel(OPTIONS[0]), 'Opus 5.5');
  assert.equal(formatModelOptionHint(OPTIONS[0]), 'Default (recommended)');
  assert.equal(formatModelOptionHint(OPTIONS[1]), undefined);
  assert.equal(formatModelOptionHint(OPTIONS[2]), 'Sonnet (1M context)');
  assert.equal(
    formatModelOptionHint({ value: 'opus[1m]', label: 'Opus (1M context)', resolvedLabel: 'Opus 5.5 (1M context)' }),
    undefined,
  );
  // Unresolved (older server, or the CLI could not answer): unchanged.
  assert.equal(formatModelOptionLabel(OPTIONS[3]), 'Haiku');
  assert.equal(formatModelOptionHint(OPTIONS[3]), undefined);
});

const renderMenu = (effort: string, model: string) => render(
  <ComposerModelMenu
    effort={effort}
    effortOptions={EFFORT_VALUES}
    onSelectEffort={() => {}}
    model={model}
    modelOptions={OPTIONS}
    onSelectModel={() => {}}
    modelsLoading={false}
  />,
);

test('the composer names the model and the level "default" stands for', () => {
  renderMenu('default', 'default');

  const trigger = screen.getByRole('button');
  assert.match(trigger.textContent ?? '', /Opus 5\.5/);
  assert.match(trigger.textContent ?? '', /xhigh/);

  fireEvent.click(trigger);
  assert.ok(screen.getByRole('menuitemradio', { name: /Default \(xhigh\)/ }));

  fireEvent.click(screen.getByRole('menuitem', { name: /Opus 5\.5/ }));
  const modelItems = screen.getAllByRole('menuitemradio').map((item) => item.textContent);
  assert.ok(modelItems.some((text) => text?.includes('Opus 5.5') && text.includes('Default (recommended)')));
  assert.ok(modelItems.some((text) => text?.includes('Sonnet 5.5') && text.includes('Sonnet (1M context)')));
  assert.ok(modelItems.includes('Haiku'));
});

test('an explicit level is shown as chosen', () => {
  renderMenu('high', 'sonnet');

  const trigger = screen.getAllByRole('button').at(-1)!;
  assert.match(trigger.textContent ?? '', /Sonnet 5\.5/);
  assert.match(trigger.textContent ?? '', /high/);
  assert.doesNotMatch(trigger.textContent ?? '', /xhigh/);
});
