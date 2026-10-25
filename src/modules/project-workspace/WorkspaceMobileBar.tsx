import { useRef, type Dispatch, type SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '@/shared/types';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';
import { useKeyboardOpen } from '@/modules/project-workspace/hooks/useKeyboardOpen';

type WorkspaceMobileBarProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  onMenuClick: () => void;
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/**
 * Rendered by WorkspaceMain below the content on phones, in place of
 * WorkspaceHeader: one row within thumb reach instead of two at the top. It
 * hides while the phone keyboard is up, when the keyboard needs the room.
 */
export default function WorkspaceMobileBar({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  onMenuClick,
  onRenameSession,
}: WorkspaceMobileBarProps) {
  const barRef = useRef<HTMLElement>(null);
  const isKeyboardOpen = useKeyboardOpen(barRef);
  if (isKeyboardOpen) {
    return null;
  }

  return (
    <nav ref={barRef} className="flex-shrink-0 border-t border-border/60 bg-background/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-sm">
      <div className="flex h-12 min-w-0 items-center gap-1.5 pl-1.5 pr-2">
        <MobileMenuButton onMenuClick={onMenuClick} />
        <WorkspaceTitle
          activeTab={activeTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={shouldShowTasksTab}
          onRenameSession={onRenameSession}
        />
        <WorkspaceConnectionStatus />
        <div className="scrollbar-hide max-w-[60%] flex-shrink-0 overflow-x-auto">
          <WorkspaceTabs
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
            compact
          />
        </div>
      </div>
    </nav>
  );
}
