import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import type { Question } from '@/shared/types';

/**
 * Claude sessions are no longer tagged as SDK clients, so Claude Code tells the
 * model it may attach a preview (a mockup or code variant to compare) to each
 * option of a single-select question. The panel showed only labels and
 * descriptions, and a question that carried its substance in the previews
 * reached the user without it.
 */

const renderPanel = (question: Question) => render(
  <AskUserQuestionPanel
    request={{ requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [question] } }}
    onDecision={() => {}}
  />,
);

const layouts: Question = {
  question: 'Which layout?',
  options: [
    { label: 'Sidebar', preview: 'SIDEBAR MOCKUP' },
    { label: 'Tabs', preview: 'TABS MOCKUP' },
    { label: 'Neither' },
  ],
};

test('the first preview shows before a choice, then the chosen option\'s', () => {
  renderPanel(layouts);
  assert.ok(screen.getByText('SIDEBAR MOCKUP'));

  fireEvent.click(screen.getByText('Tabs'));
  assert.ok(screen.getByText('TABS MOCKUP'));
  assert.equal(screen.queryByText('SIDEBAR MOCKUP'), null);
});

test('an option without a preview, or Other, shows none', () => {
  renderPanel(layouts);
  fireEvent.click(screen.getByText('Neither'));
  assert.equal(screen.queryByText(/MOCKUP/), null);

  fireEvent.click(screen.getByText('Tabs'));
  fireEvent.click(screen.getByText('Other...'));
  assert.equal(screen.queryByText(/MOCKUP/), null);
});

test('a multi-select question shows no preview', () => {
  renderPanel({ ...layouts, multiSelect: true });
  assert.equal(screen.queryByText(/MOCKUP/), null);
});
