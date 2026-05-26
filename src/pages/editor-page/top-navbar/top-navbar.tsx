import ChartDBDarkLogo from '@/assets/logo-dark.png';
import ChartDBLogo from '@/assets/logo-light.png';
import { Button } from '@/components/button/button';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { useAIChatPanel } from '@/dialogs/ai-chat-panel/use-ai-chat-panel';
import { LogOut, Sparkles } from 'lucide-react';
import React, { useCallback } from 'react';
import { DiagramName } from './diagram-name';
import { LanguageNav } from './language-nav/language-nav';
import { LastSaved } from './last-saved';
import { Menu } from './menu/menu';
import { SyncStatusIndicator } from './sync-status-indicator';

export interface TopNavbarProps {}

export const TopNavbar: React.FC<TopNavbarProps> = () => {
    const { effectiveTheme } = useTheme();
    const { signOut, user } = useAuth();
    const { toggle: toggleAIChatPanel } = useAIChatPanel();

    const renderStars = useCallback(() => {
        return (
            <iframe
                src={`https://ghbtns.com/github-btn.html?user=chartdb&repo=chartdb&type=star&size=large&text=false`}
                width="40"
                height="30"
                title="GitHub"
            ></iframe>
        );
    }, []);

    return (
        <nav className="flex flex-col justify-between border-b px-3 md:h-12 md:flex-row md:items-center md:px-4">
            <div className="flex flex-1 flex-col justify-between gap-x-1 md:flex-row md:justify-normal">
                <div className="flex items-center justify-between pt-[8px] font-primary md:py-[10px]">
                    <a
                        href="https://chartdb.io"
                        className="cursor-pointer"
                        rel="noreferrer"
                    >
                        <img
                            src={
                                effectiveTheme === 'light'
                                    ? ChartDBLogo
                                    : ChartDBDarkLogo
                            }
                            alt="chartDB"
                            className="h-4 max-w-fit"
                        />
                    </a>
                </div>
                <Menu />
            </div>
            <DiagramName />
            <div className="hidden flex-1 items-center justify-end gap-2 sm:flex">
                <LastSaved />
                {user && <SyncStatusIndicator />}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleAIChatPanel}
                            aria-label="Open AI assistant"
                        >
                            <Sparkles className="size-4 text-amber-500" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>AI assistant</TooltipContent>
                </Tooltip>
                {renderStars()}
                <LanguageNav />
                {user && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => signOut()}
                                aria-label="Sign out"
                            >
                                <LogOut className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Sign out ({user.email})</TooltipContent>
                    </Tooltip>
                )}
            </div>
        </nav>
    );
};
