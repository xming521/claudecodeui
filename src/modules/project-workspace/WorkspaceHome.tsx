import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Folder, Loader2, MessageSquare, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { useBackgroundSessionIdSet, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import type { Project, RecentConversationListItem } from '@/shared/types';
import { Button, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';

const PAGE_SIZE = 20;
// The server caps `limit` at 100. "Show more" grows the one request instead of
// paging, so a refresh after a session update reloads everything on screen.
const MAX_LIMIT = 100;
const QUICK_PROJECT_COUNT = 3;

type RecentConversationsApiPayload = {
  data?: {
    conversations?: RecentConversationListItem[];
    hasMore?: boolean;
  };
};

type WorkspaceHomeProps = {
  isMobile: boolean;
  onMenuClick: () => void;
};

function formatRelativeTime(value: string | null, now: number, t: TFunction): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';

  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });

  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.daysAgo', { count: days });
  return new Date(time).toLocaleDateString();
}

function ChooseProjectPrompt({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="mx-auto max-w-md px-6 text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
          <Folder className="h-7 w-7 text-muted-foreground" />
        </div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
        <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
          <p className="text-sm text-primary">
            <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Rendered by WorkspaceStateView when no project is selected: one-tap new chats
 * in the most recently used projects and the latest conversations across all
 * projects, so opening the app lands on something to do. Falls back to the
 * "choose your project" prompt while there are no conversations at all.
 */
export default function WorkspaceHome({ isMobile, onMenuClick }: WorkspaceHomeProps) {
  const { t } = useTranslation();
  // The sidebar's bundle already carries the project list and the same select
  // and new-session handlers its own Conversations tab uses.
  const { sidebarSharedProps } = useProjectSidebarState();
  const { projects, attentionSessionIds, onProjectSelect, onSessionSelect, onNewSession } = sidebarSharedProps;
  const busySessionIds = useBusySessionIdSet();
  const backgroundSessionIds = useBackgroundSessionIdSet();

  const [conversations, setConversations] = useState<RecentConversationListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [now, setNow] = useState(() => Date.now());
  // Bumped to refetch the list with the current limit.
  const [refreshTick, setRefreshTick] = useState(0);
  const isFirstProjectsUpdateRef = useRef(true);

  useEffect(() => {
    // Only the newest request may write: a slow earlier one would roll the list back.
    let superseded = false;
    const load = async () => {
      try {
        const response = await api.recentConversations({ limit });
        if (!response.ok) {
          throw new Error(`Failed to load recent conversations: ${response.status}`);
        }
        const payload = (await response.json()) as RecentConversationsApiPayload;
        if (superseded) return;
        setConversations(Array.isArray(payload.data?.conversations) ? payload.data.conversations : []);
        setHasMore(Boolean(payload.data?.hasMore));
        setStatus('ready');
      } catch (error) {
        if (superseded) return;
        console.error('[WorkspaceHome] Failed to load recent conversations:', error);
        // A failed background refresh keeps the list already on screen.
        setStatus((previous) => (previous === 'ready' ? previous : 'error'));
      }
    };
    void load();
    return () => {
      superseded = true;
    };
  }, [limit, refreshTick]);

  // `projects` is replaced whenever a session is created, renamed or updated,
  // so it doubles as the signal that the recents feed has moved.
  useEffect(() => {
    if (isFirstProjectsUpdateRef.current) {
      isFirstProjectsUpdateRef.current = false;
      return undefined;
    }
    const timer = setTimeout(() => setRefreshTick((tick) => tick + 1), 1000);
    return () => clearTimeout(timer);
  }, [projects]);

  // A phone PWA resumed from the background shows stale times and rows otherwise.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        setRefreshTick((tick) => tick + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // The projects of the latest conversations, most recent first.
  const quickProjects = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.projectId, project]));
    const picked: Project[] = [];
    const seen = new Set<string>();
    for (const conversation of conversations) {
      const project = conversation.projectId ? projectById.get(conversation.projectId) : undefined;
      if (!project || seen.has(project.projectId)) continue;
      seen.add(project.projectId);
      picked.push(project);
      if (picked.length === QUICK_PROJECT_COUNT) break;
    }
    return picked;
  }, [conversations, projects]);

  // Same steps as the sidebar's Conversations tab: select the owning project,
  // then the session, reusing the loaded session object when there is one.
  const openConversation = useCallback((conversation: RecentConversationListItem) => {
    const project = conversation.projectId
      ? projects.find((candidate) => candidate.projectId === conversation.projectId)
      : undefined;
    const loadedSession = project?.sessions?.find((session) => session.id === conversation.sessionId);

    if (project) {
      onProjectSelect(project);
    }
    onSessionSelect({
      ...(loadedSession ?? { id: conversation.sessionId, summary: conversation.sessionTitle }),
      __provider: conversation.provider,
      __projectId: conversation.projectId ?? undefined,
    });
  }, [onProjectSelect, onSessionSelect, projects]);

  if (status === 'ready' && conversations.length === 0) {
    return <ChooseProjectPrompt isMobile={isMobile} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6 sm:py-8">
        {quickProjects.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t('mainContent.newChat')}</h2>
            <div className="flex flex-wrap gap-2">
              {quickProjects.map((project) => (
                <Button
                  key={project.projectId}
                  variant="outline"
                  size="sm"
                  className="max-w-full rounded-full"
                  onClick={() => onNewSession(project)}
                >
                  <Plus />
                  <span className="truncate">{project.displayName}</span>
                </Button>
              ))}
              {isMobile && (
                <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={onMenuClick}>
                  <Folder />
                  {t('mainContent.allProjects')}
                </Button>
              )}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t('mainContent.recentConversations')}</h2>

          {status === 'loading' && (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-3">
                  <div className="h-8 w-8 animate-pulse rounded-lg bg-muted" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${80 - index * 6}%` }} />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted/70" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {status === 'error' && (
            <div className="rounded-xl border border-border/60 bg-card px-4 py-8 text-center">
              <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-foreground">{t('mainContent.loadRecentFailed')}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setStatus('loading');
                  setRefreshTick((tick) => tick + 1);
                }}
              >
                {t('buttons.retry')}
              </Button>
            </div>
          )}

          {status === 'ready' && (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
              {conversations.map((conversation) => {
                const hasBackgroundWork = backgroundSessionIds.has(conversation.sessionId);
                const isProcessing = busySessionIds.has(conversation.sessionId) && !hasBackgroundWork;
                const needsAttention = attentionSessionIds.has(conversation.sessionId);

                const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                    return;
                  }
                  event.preventDefault();
                  openConversation(conversation);
                };

                return (
                  <a
                    key={conversation.sessionId}
                    href={`/session/${conversation.sessionId}`}
                    onClick={handleClick}
                    className="flex touch-manipulation items-center gap-3 px-3 py-3 transition-colors hover:bg-accent/60 active:bg-accent"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60">
                      <LLMProviderLogo provider={conversation.provider} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 break-words text-sm leading-5 text-foreground">
                        {conversation.sessionTitle}
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">{conversation.projectDisplayName}</span>
                        <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                        <time className="flex-shrink-0 tabular-nums" dateTime={conversation.lastActivity ?? undefined}>
                          {formatRelativeTime(conversation.lastActivity, now, t)}
                        </time>
                      </span>
                    </span>
                    {isProcessing ? (
                      <Loader2
                        className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground"
                        aria-label={t('mainContent.sessionRunning')}
                      />
                    ) : (hasBackgroundWork || needsAttention) && (
                      <span
                        role="status"
                        aria-label={hasBackgroundWork ? t('mainContent.sessionRunning') : t('mainContent.sessionNeedsAttention')}
                        className={cn(
                          'h-2 w-2 flex-shrink-0 animate-pulse rounded-full',
                          hasBackgroundWork ? 'bg-purple-500 dark:bg-purple-400' : 'bg-amber-500',
                        )}
                      />
                    )}
                  </a>
                );
              })}
            </div>
          )}

          {status === 'ready' && hasMore && limit < MAX_LIMIT && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full text-muted-foreground"
              onClick={() => setLimit((previous) => Math.min(previous + PAGE_SIZE, MAX_LIMIT))}
            >
              {t('mainContent.showMore')}
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
