import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * The Projects list draws a session's state as a dot on the row's left edge:
 * amber when it needs the user, green when its last turn finished and the user
 * has not opened it since. A session
 * whose turn has ended while the tasks it launched still run takes that slot
 * in the purple of the workflow and agent cards, saying what is still going
 * on — while the spinner and the destructive-action lockout stay reserved for
 * a response in flight.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

const renderRow = (state: {
  isProcessing: boolean;
  hasBackgroundWork: boolean;
  isFinished?: boolean;
  selectedSession?: SessionWithProvider | null;
}) => render(
  React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session: SESSION,
    selectedSession: null,
    needsAttention: false,
    isFinished: false,
    currentTime: NOW,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
    ...state,
  }),
);

beforeEach(() => {
  recordedOptionsProps.length = 0;
});

test('background work shows as the purple dot in place of the green one, with nothing spinning', () => {
  const idle = renderRow({ isProcessing: false, hasBackgroundWork: false, isFinished: true });
  assert.ok(idle.container.querySelector('[role="status"].bg-green-500'), 'the fixture has an unseen finished turn');
  idle.unmount();

  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: true, isFinished: true });

  const dot = container.querySelector('[role="status"]');
  assert.ok(dot);
  assert.ok(dot.className.includes('bg-purple-500'));
  assert.ok(!dot.className.includes('bg-green-500'));
  assert.equal(dot.getAttribute('aria-label'), 'tooltips.backgroundWorkIndicator');
  assert.equal(container.querySelectorAll('.animate-spin').length, 0);
  assert.equal(recordedOptionsProps.at(-1)?.isProcessing, false, 'the row is not locked the way a responding one is');
});

test('a response in flight still spins and shows no dot', () => {
  const { container } = renderRow({ isProcessing: true, hasBackgroundWork: false });

  assert.equal(container.querySelector('[role="status"]'), null);
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
  assert.equal(recordedOptionsProps[0].isProcessing, true);
});

test('the green dot means a finished turn the user has not opened, not recent activity', () => {
  // Touched a minute ago, but nothing waiting: no dot.
  const recent = renderRow({ isProcessing: false, hasBackgroundWork: false });
  assert.equal(recent.container.querySelector('[role="status"]'), null);
  recent.unmount();

  const finished = renderRow({ isProcessing: false, hasBackgroundWork: false, isFinished: true });
  const dot = finished.container.querySelector('[role="status"]');
  assert.ok(dot?.className.includes('bg-green-500'));
  assert.ok(!dot?.className.includes('animate-pulse'), 'a reply waiting is calm, not urgent');
  assert.equal(dot?.getAttribute('aria-label'), 'tooltips.finishedSessionIndicator');
  finished.unmount();

  // The session on screen is being read already.
  const open = renderRow({ isProcessing: false, hasBackgroundWork: false, isFinished: true, selectedSession: SESSION });
  assert.equal(open.container.querySelector('[role="status"]'), null);
});
