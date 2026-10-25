import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession, RecentConversationListItem } from '@/shared/types';

/**
 * With no project selected the workspace used to show only "Choose your
 * project", so every visit started with a trip through the sidebar. It now
 * lists the latest conversations and offers a new chat in recent projects.
 * These tests drive the real component against a stubbed recents API and the
 * same handlers the sidebar hands its own rows.
 */

const recentConversations = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { recentConversations: (...args: unknown[]) => recentConversations(...args) },
}));

const busySessionIds = new Set<string>();
const backgroundSessionIds = new Set<string>();
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => busySessionIds,
  useBackgroundSessionIdSet: () => backgroundSessionIds,
  useSessionIndicatorSets: () => ({ attentionSessionIds: new Set<string>(), finishedSessionIds: new Set<string>() }),
}));

const onProjectSelect = vi.fn<(project: Project) => void>();
const onSessionSelect = vi.fn<(session: ProjectSession) => void>();
const onNewSession = vi.fn<(project: Project) => void>();
let projects: Project[] = [];
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => ({
    sidebarSharedProps: {
      projects,
      onProjectSelect,
      onSessionSelect,
      onNewSession,
    },
  }),
}));

const { default: WorkspaceHome } = await import('@/modules/project-workspace/WorkspaceHome');

const PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  sessions: [],
};

const conversation = (
  sessionId: string,
  overrides: Partial<RecentConversationListItem> = {},
): RecentConversationListItem => ({
  sessionId,
  provider: 'codex',
  projectId: PROJECT.projectId,
  projectDisplayName: PROJECT.displayName,
  sessionTitle: `title of ${sessionId}`,
  lastActivity: new Date().toISOString(),
  ...overrides,
});

const respondWith = (conversations: RecentConversationListItem[]) => {
  recentConversations.mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: { conversations, total: conversations.length, hasMore: false },
  })));
};

beforeEach(() => {
  recentConversations.mockReset();
  onProjectSelect.mockReset();
  onSessionSelect.mockReset();
  onNewSession.mockReset();
  busySessionIds.clear();
  backgroundSessionIds.clear();
  projects = [PROJECT];
});

test('opening a recent conversation selects its project, then the session', async () => {
  respondWith([conversation('s-1')]);
  render(<WorkspaceHome isMobile onMenuClick={() => {}} />);

  fireEvent.click(await screen.findByText('title of s-1'));

  assert.deepEqual(onProjectSelect.mock.calls, [[PROJECT]]);
  assert.equal(onSessionSelect.mock.calls.length, 1);
  const [session] = onSessionSelect.mock.calls[0];
  assert.equal(session.id, 's-1');
  assert.equal(session.__projectId, PROJECT.projectId);
  assert.equal(session.__provider, 'codex');
});

test('a conversation whose project is not loaded still opens by session id', async () => {
  respondWith([conversation('s-2', { projectId: null })]);
  render(<WorkspaceHome isMobile={false} onMenuClick={() => {}} />);

  fireEvent.click(await screen.findByText('title of s-2'));

  assert.equal(onProjectSelect.mock.calls.length, 0);
  assert.equal(onSessionSelect.mock.calls[0][0].id, 's-2');
});

test('the new-chat button starts a session in a project from the recents', async () => {
  respondWith([conversation('s-1'), conversation('s-2')]);
  render(<WorkspaceHome isMobile onMenuClick={() => {}} />);

  const buttons = await screen.findAllByRole('button', { name: PROJECT.displayName });
  assert.equal(buttons.length, 1, 'one button per project, however many of its sessions are listed');
  fireEvent.click(buttons[0]);

  assert.deepEqual(onNewSession.mock.calls, [[PROJECT]]);
});

test('a running session is marked in the list', async () => {
  respondWith([conversation('s-1'), conversation('s-2')]);
  busySessionIds.add('s-2');
  const { container } = render(<WorkspaceHome isMobile onMenuClick={() => {}} />);

  await screen.findByText('title of s-2');
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
});

test('with no conversations at all it falls back to the choose-a-project prompt', async () => {
  respondWith([]);
  render(<WorkspaceHome isMobile onMenuClick={() => {}} />);

  await screen.findByText('Choose Your Project');
  assert.equal(screen.queryAllByRole('link').length, 0);
});
