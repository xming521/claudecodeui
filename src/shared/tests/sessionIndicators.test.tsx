import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The sidebar's "your turn" dots come from the running-sessions poll. Amber:
 * a run blocked on an approval or a question, or a turn that failed since the
 * session was last opened. Green: a turn that finished since then. Opening a
 * session clears its dot at once, even if a poll already in flight still
 * lists it.
 */

const runningSessions = vi.fn();
const markSessionViewed = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => runningSessions(),
    markSessionViewed: (sessionId: string) => markSessionViewed(sessionId),
  },
}));

const pollResponse = (unseenTurns: Array<{ sessionId: string; outcome: string }>) => ({
  ok: true,
  json: async () => ({
    data: {
      sessions: [
        { sessionId: 'asking', provider: 'claude', startedAt: 1, lastSeq: 0, waitingForInput: true },
        { sessionId: 'working', provider: 'claude', startedAt: 1, lastSeq: 0 },
      ],
      unseenTurns,
    },
  }),
});

// The provider polls on a 5 s interval. The tests run that poll by hand
// rather than faking timers, which waitFor itself relies on.
let intervalSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
const runNextPoll = async () => {
  const pollCall = intervalSpy.mock.calls.find((call) => call[1] === 5_000);
  assert.ok(pollCall, 'the provider polls on an interval');
  await act(async () => {
    (pollCall[0] as () => void)();
  });
};

beforeEach(() => {
  vi.resetModules();
  intervalSpy = vi.spyOn(window, 'setInterval');
  runningSessions.mockReset();
  markSessionViewed.mockReset();
  markSessionViewed.mockResolvedValue({ ok: true });
});

afterEach(() => {
  intervalSpy.mockRestore();
});

const renderIndicators = async () => {
  const { SessionProtectionProvider, useSessionIndicatorSets, useSessionProtectionActions } =
    await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  return renderHook(
    () => ({ indicators: useSessionIndicatorSets(), actions: useSessionProtectionActions() }),
    { wrapper },
  );
};

const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

test('the poll sorts sessions into the amber and the green dot', async () => {
  runningSessions.mockResolvedValue(pollResponse([
    { sessionId: 'done', outcome: 'completed' },
    { sessionId: 'broke', outcome: 'error' },
  ]));

  const { result } = await renderIndicators();

  await waitFor(() => assert.deepEqual(sorted(result.current.indicators.attentionSessionIds), ['asking', 'broke']));
  assert.deepEqual(sorted(result.current.indicators.finishedSessionIds), ['done']);
});

test('opening a session clears its dot at once and a stale poll does not bring it back', async () => {
  runningSessions.mockResolvedValue(pollResponse([{ sessionId: 'done', outcome: 'completed' }]));
  const { result } = await renderIndicators();
  await waitFor(() => assert.deepEqual(sorted(result.current.indicators.finishedSessionIds), ['done']));

  act(() => {
    result.current.actions.markSessionViewed('done');
  });
  assert.deepEqual(sorted(result.current.indicators.finishedSessionIds), []);
  assert.deepEqual(markSessionViewed.mock.calls, [['done']]);

  // This poll was answered before the server stored the visit.
  await runNextPoll();
  await waitFor(() => assert.equal(runningSessions.mock.calls.length, 2));
  assert.deepEqual(sorted(result.current.indicators.finishedSessionIds), []);
});

test('a poll that changes nothing keeps the same sets', async () => {
  runningSessions.mockResolvedValue(pollResponse([{ sessionId: 'done', outcome: 'completed' }]));
  const { result } = await renderIndicators();
  await waitFor(() => assert.deepEqual(sorted(result.current.indicators.finishedSessionIds), ['done']));
  const before = result.current.indicators;

  await runNextPoll();
  await waitFor(() => assert.equal(runningSessions.mock.calls.length, 2));
  assert.equal(result.current.indicators, before);
});
