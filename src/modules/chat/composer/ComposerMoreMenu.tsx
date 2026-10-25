import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  Loader2,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import { ScheduleMenuBody } from '@/modules/chat/composer/ScheduleMessagePopover';
import { formatTokenCount, readUsedTokens } from '@/modules/chat/composer/TokenUsageSummary';
import { TRANSCRIPT_EXPORT_FORMATS, type TranscriptExport } from '@/modules/chat/transcript/ChatExportMenu';

type ComposerMoreMenuProps = {
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  /** False while the box is empty: there is nothing to schedule yet. */
  canSchedule: boolean;
  onSchedule: (scheduledFor: Date) => void;
  transcriptExport?: TranscriptExport;
  onOpenQuickSettings?: () => void;
  className?: string;
};

type MenuView = 'main' | 'schedule' | 'export';

/**
 * Rendered by chat's ChatComposer on phones in place of the token, commands
 * and schedule buttons, the transcript's export button and the quick settings
 * edge handle, so those stop taking room from the conversation.
 */
export default function ComposerMoreMenu({
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  canSchedule,
  onSchedule,
  transcriptExport,
  onOpenQuickSettings,
  className,
}: ComposerMoreMenuProps) {
  const { t } = useTranslation(['chat', 'settings']);
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<MenuView>('main');
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 280);

  const runAndClose = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  const backRow = (
    <ComposerMenuItem
      role="menuitem"
      label={t('composer.more.back')}
      icon={<ChevronLeftIcon className="h-4 w-4" />}
      isSelected={false}
      onSelect={() => setView('main')}
      className="text-muted-foreground"
    />
  );
  const chevron = <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />;
  const ariaLabel = t('composer.more.trigger');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setView('main');
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          isOpen && 'text-foreground',
          className,
        )}
      >
        <MoreHorizontalIcon className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {view === 'main' && (
            <>
              <ComposerMenuItem
                role="menuitem"
                label={t('composer.more.tokens')}
                icon={<ActivityIcon className="h-4 w-4" />}
                isSelected={false}
                onSelect={() => runAndClose(onShowTokenUsage)}
                trailing={<span className="text-xs text-muted-foreground">{formatTokenCount(readUsedTokens(tokenBudget))}</span>}
              />
              <ComposerMenuItem
                role="menuitem"
                label={t('composer.more.commands')}
                icon={<MessageSquareIcon className="h-4 w-4" />}
                isSelected={false}
                onSelect={() => runAndClose(onToggleCommandMenu)}
                trailing={slashCommandsCount > 0
                  ? <span className="text-xs text-muted-foreground">{slashCommandsCount}</span>
                  : undefined}
              />
              <ComposerMenuItem
                role="menuitem"
                label={t('composer.more.schedule')}
                description={canSchedule ? undefined : t('composer.more.scheduleNeedsText')}
                icon={<ClockIcon className="h-4 w-4" />}
                isSelected={false}
                onSelect={() => { if (canSchedule) setView('schedule'); }}
                trailing={canSchedule ? chevron : undefined}
                className={canSchedule ? undefined : 'opacity-50'}
              />
              {transcriptExport?.canExport && (
                <ComposerMenuItem
                  role="menuitem"
                  label={t('export.trigger')}
                  icon={transcriptExport.busyFormat
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <DownloadIcon className="h-4 w-4" />}
                  isSelected={false}
                  onSelect={() => setView('export')}
                  trailing={chevron}
                />
              )}
              {onOpenQuickSettings && (
                <>
                  <ComposerMenuSeparator />
                  <ComposerMenuItem
                    role="menuitem"
                    label={t('settings:quickSettings.title')}
                    icon={<SlidersHorizontalIcon className="h-4 w-4" />}
                    isSelected={false}
                    onSelect={() => runAndClose(onOpenQuickSettings)}
                  />
                </>
              )}
            </>
          )}

          {view === 'schedule' && (
            <>
              {backRow}
              <ComposerMenuSeparator />
              <ScheduleMenuBody onCommit={(scheduledFor) => runAndClose(() => onSchedule(scheduledFor))} />
            </>
          )}

          {view === 'export' && transcriptExport && (
            <>
              {backRow}
              <ComposerMenuSeparator />
              <ComposerMenuHeading>{t('export.heading')}</ComposerMenuHeading>
              {TRANSCRIPT_EXPORT_FORMATS.map((format) => (
                <ComposerMenuItem
                  key={format.id}
                  role="menuitem"
                  label={t(format.labelKey)}
                  description={t(format.descriptionKey)}
                  icon={transcriptExport.busyFormat === format.id
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <format.icon className="h-4 w-4" />}
                  isSelected={false}
                  onSelect={() => runAndClose(() => { void transcriptExport.runExport(format.id); })}
                />
              ))}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
