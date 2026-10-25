import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * After a reconnect the page can send two `chat.subscribe` frames close
 * together (the reconnect handler and the session effect), and each gets a
 * replay of the same missed events. The server's seqs only grow within a
 * session, so the second copy is the one at or below what was already seen.
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: NormalizedMessage[] = [];
  const lastSeqRef = { current: new Map<string, number>() };

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef,
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sid: string, message: NormalizedMessage) => { appended.push(message); },
    } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, appended, lastSeqRef };
};

const toolResult = (id: string, seq: number): ServerEvent => ({
  kind: 'tool_result',
  id,
  toolId: `tool-${id}`,
  content: 'ok',
  sessionId: 'viewed-session',
  seq,
} as unknown as ServerEvent);

test('a second replay of the same events is ignored', () => {
  const { dispatch, appended, lastSeqRef } = renderHandlers();

  // First replay.
  dispatch(toolResult('a', 1_000_001));
  dispatch(toolResult('b', 1_000_002));
  // The second subscribe's replay repeats both.
  dispatch(toolResult('a', 1_000_001));
  dispatch(toolResult('b', 1_000_002));
  // Live events continue.
  dispatch(toolResult('c', 1_000_003));

  assert.deepEqual(appended.map((message) => message.id), ['a', 'b', 'c']);
  assert.equal(lastSeqRef.current.get('viewed-session'), 1_000_003);
});

test('a later turn, which starts above the earlier one, is delivered', () => {
  const { dispatch, appended } = renderHandlers();

  dispatch(toolResult('old', 1_000_500));
  dispatch(toolResult('new', 2_000_001));

  assert.deepEqual(appended.map((message) => message.id), ['old', 'new']);
});

test('unsequenced frames are never dropped', () => {
  const { dispatch, appended } = renderHandlers();

  dispatch(toolResult('a', 1_000_001));
  dispatch({ kind: 'tool_result', id: 'local', toolId: 'tool-local', content: 'ok', sessionId: 'viewed-session' } as unknown as ServerEvent);

  assert.deepEqual(appended.map((message) => message.id), ['a', 'local']);
});
