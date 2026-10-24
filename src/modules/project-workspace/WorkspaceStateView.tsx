import { useTranslation } from 'react-i18next';

import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceHome from '@/modules/project-workspace/WorkspaceHome';

type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain instead of the workspace while projects load, and as the home screen when none is selected. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick }: WorkspaceStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <WorkspaceHome isMobile={isMobile} onMenuClick={onMenuClick} />
      )}
    </div>
  );
}
