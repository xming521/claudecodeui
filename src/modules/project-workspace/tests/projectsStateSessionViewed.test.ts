import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * A finished turn stops counting as unseen once the user has had the session
 * in front of them: when they open it, when they leave it, when they come
 * back to the page with it open, and when the turn ends while they watch.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
};

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const markSessionViewed = vi.fn<(sessionId: string) => void>();

const renderProjectsState = async (initialSessionId: string | undefined) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(
    ({ sessionId }: { sessionId: string | undefined }) => useProjectsState({
      sessionId,
      navigate: vi.fn(),
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
      markSessionViewed,
    }),
    { initialProps: { sessionId: initialSessionId } },
  );
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [PROJECT] });
  listeners.clear();
  markSessionViewed.mockReset();
  setVisibility('visible');
});

afterEach(() => {
  vi.resetModules();
});

test('opening, leaving and returning to a session each count as seeing it', async () => {
  const { rerender } = await renderProjectsState('session-a');
  await waitFor(() => assert.deepEqual(markSessionViewed.mock.calls, [['session-a']]));

  rerender({ sessionId: 'session-b' });
  // Leaving A, then opening B.
  assert.deepEqual(markSessionViewed.mock.calls.slice(1), [['session-a'], ['session-b']]);

  markSessionViewed.mockClear();
  setVisibility('hidden');
  setVisibility('visible');
  assert.deepEqual(markSessionViewed.mock.calls, [['session-b']]);
});

test('a turn ending on screen counts as seen, one ending elsewhere or out of sight does not', async () => {
  await renderProjectsState('session-a');
  await waitFor(() => assert.equal(listeners.size > 0, true));
  markSessionViewed.mockClear();

  await act(async () => {
    emit({ kind: 'complete', sessionId: 'session-other', exitCode: 0 });
  });
  assert.deepEqual(markSessionViewed.mock.calls, []);

  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await act(async () => {
    emit({ kind: 'complete', sessionId: 'session-a', exitCode: 0 });
  });
  assert.deepEqual(markSessionViewed.mock.calls, []);

  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  await act(async () => {
    emit({ kind: 'complete', sessionId: 'session-a', exitCode: 0 });
  });
  assert.deepEqual(markSessionViewed.mock.calls, [['session-a']]);
});
