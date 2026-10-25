import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
  background?: unknown;
  tasks?: unknown;
  waitingForInput?: unknown;
};

type UnseenTurnApiItem = {
  sessionId?: unknown;
  outcome?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
    unseenTurns?: UnseenTurnApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
  /** Records that the user has the session in front of them, which clears its finished/failed dot everywhere. */
  markSessionViewed: (sessionId: string) => void;
};

/**
 * The sidebar's two "your turn" dots. Amber: the session is blocked on the
 * user (a tool approval or a question) or its last turn failed since they last
 * opened it. Green: its last turn finished since then and the reply is ready.
 */
export type SessionIndicatorSets = {
  attentionSessionIds: ReadonlySet<string>;
  finishedSessionIds: ReadonlySet<string>;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const SessionIndicatorsContext = createContext<SessionIndicatorSets | null>(null);

/**
 * How long a session the user just opened keeps its dot hidden whatever the
 * poll says. A poll sent before the "viewed" request can answer after it.
 */
const VIEWED_SUPPRESSION_MS = 15_000;

const toIdKey = (ids: Iterable<string>): string => [...new Set(ids)].sort().join('\u0000');
const fromIdKey = (key: string): ReadonlySet<string> => new Set(key ? key.split('\u0000') : []);
const withoutId = (key: string, sessionId: string): string =>
  toIdKey([...fromIdKey(key)].filter((id) => id !== sessionId));

/**
 * The set of session ids whose activity passes `include`, with a stable
 * identity while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useSessionIdSet(
  processingSessions: SessionActivityMap,
  include: (activity: SessionActivity) => boolean,
): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions]
    .filter(([, activity]) => include(activity))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const isAnyActivity = () => true;
const isBackgroundOnly = (activity: SessionActivity) => Boolean(activity.background);

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The poll's task list, kept only when every entry has the shape the indicator reads. */
const parseBackgroundTasks = (value: unknown): BackgroundTaskSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: BackgroundTaskSummary[] = [];
  for (const item of value) {
    const task = item as Partial<Record<keyof BackgroundTaskSummary, unknown>> | null;
    if (
      !task
      || typeof task.taskId !== 'string'
      || typeof task.toolUseId !== 'string'
      || typeof task.taskType !== 'string'
      || typeof task.description !== 'string'
      || typeof task.startedAt !== 'number'
    ) {
      // One entry the server wrote in a shape this client does not read
      // should not hide the rest of the session's work.
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      taskType: task.taskType,
      description: task.description,
      ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
      startedAt: task.startedAt,
      ...(task.nested === true ? { nested: true } : {}),
    });
  }
  return tasks;
};

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response or running background tasks — so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  } = useSessionProtection();

  // Sorted id lists joined into strings, so a poll that changes nothing does
  // not hand the sidebar new sets.
  const [waitingKey, setWaitingKey] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const [finishedKey, setFinishedKey] = useState('');
  const viewedAtRef = useRef(new Map<string, number>());

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      const now = Date.now();
      for (const [sessionId, viewedAt] of viewedAtRef.current) {
        if (now - viewedAt > VIEWED_SUPPRESSION_MS) {
          viewedAtRef.current.delete(sessionId);
        }
      }
      const unseenTurns = (Array.isArray(payload.data?.unseenTurns) ? payload.data.unseenTurns : [])
        .filter((turn): turn is { sessionId: string; outcome: string } =>
          typeof turn?.sessionId === 'string' && typeof turn.outcome === 'string')
        .filter((turn) => !viewedAtRef.current.has(turn.sessionId));
      setFailedKey(toIdKey(unseenTurns.filter((turn) => turn.outcome === 'error').map((turn) => turn.sessionId)));
      setFinishedKey(toIdKey(unseenTurns.filter((turn) => turn.outcome === 'completed').map((turn) => turn.sessionId)));
      setWaitingKey(toIdKey(sessions
        .filter((session) => session.waitingForInput === true && typeof session.sessionId === 'string')
        .map((session) => session.sessionId as string)));

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              background: session.background === true,
              tasks: parseBackgroundTasks(session.tasks),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const markSessionViewed = useCallback((sessionId: string) => {
    if (!sessionId) {
      return;
    }
    viewedAtRef.current.set(sessionId, Date.now());
    setFailedKey((key) => withoutId(key, sessionId));
    setFinishedKey((key) => withoutId(key, sessionId));
    // A session the server does not know yet (a new chat before its first
    // send) answers 404, which is fine: it has no turn to clear.
    void api.markSessionViewed(sessionId).catch(() => undefined);
  }, []);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
      markSessionViewed,
    }),
    [
      getSessionActivity,
      isSessionProcessing,
      markSessionBackground,
      markSessionIdle,
      markSessionProcessing,
      markSessionViewed,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useSessionIdSet(processingSessions, isAnyActivity);
  const backgroundSessionIds = useSessionIdSet(processingSessions, isBackgroundOnly);
  const indicators = useMemo<SessionIndicatorSets>(() => {
    const attentionSessionIds = new Set([...fromIdKey(waitingKey), ...fromIdKey(failedKey)]);
    const finishedSessionIds = new Set([...fromIdKey(finishedKey)].filter((id) => !attentionSessionIds.has(id)));
    return { attentionSessionIds, finishedSessionIds };
  }, [failedKey, finishedKey, waitingKey]);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <BackgroundSessionIdsContext.Provider value={backgroundSessionIds}>
          <SessionIndicatorsContext.Provider value={indicators}>
            <SessionProtectionStateContext.Provider value={processingSessions}>
              {children}
            </SessionProtectionStateContext.Provider>
          </SessionIndicatorsContext.Provider>
        </BackgroundSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/** The sessions that show the amber or the green dot. Rows hide either on the session the user is looking at. */
export function useSessionIndicatorSets(): SessionIndicatorSets {
  const indicators = useContext(SessionIndicatorsContext);
  if (!indicators) {
    throw new Error('useSessionIndicatorSets must be used within SessionProtectionProvider');
  }
  return indicators;
}

/**
 * Membership-only view of the busy sessions, background work included. Prefer
 * this over useProcessingSessions wherever the activity details are not
 * rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * The busy sessions that are only running background tasks — no response in
 * flight. A subset of useBusySessionIdSet, with the same stable identity, for
 * the sidebar to draw those rows differently.
 */
export function useBackgroundSessionIdSet(): ReadonlySet<string> {
  const backgroundSessionIds = useContext(BackgroundSessionIdsContext);
  if (!backgroundSessionIds) {
    throw new Error('useBackgroundSessionIdSet must be used within SessionProtectionProvider');
  }
  return backgroundSessionIds;
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
