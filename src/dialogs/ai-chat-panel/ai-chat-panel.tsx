import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from '@/components/sheet/sheet';
import { Button } from '@/components/button/button';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { Settings, Trash2, Sparkles, AlertCircle } from 'lucide-react';
import { useAIChat } from '@/hooks/use-ai-chat';
import { useAIConfig } from '@/hooks/use-ai-config';
import { useDialog } from '@/hooks/use-dialog';
import { useAIChatPanel } from './use-ai-chat-panel';
import { ChatMessages } from './chat-messages';
import { ChatComposer } from './chat-composer';
import { ChatCostMeter } from './chat-cost-meter';
import { ChatApprovalCard } from './chat-approval-card';
import { cn } from '@/lib/utils';

export const AIChatPanel: React.FC = () => {
    const { t } = useTranslation();
    const { open, setOpen } = useAIChatPanel();
    const { state, ready, needsSetup, clear, error } = useAIChat();
    const { provider, modelByProvider } = useAIConfig();
    const { openAISettingsDialog } = useDialog();

    const activeModel = modelByProvider[provider];

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
                side="right"
                className="flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md md:max-w-lg"
            >
                <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b border-border px-4 py-3">
                    <div className="min-w-0 flex-1">
                        <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
                            <Sparkles className="size-4 text-amber-500" />
                            {t('ai_chat.title', {
                                defaultValue: 'AI Assistant',
                            })}
                        </SheetTitle>
                        <SheetDescription className="truncate text-[11px] text-muted-foreground">
                            {ready
                                ? `${provider} · ${activeModel}`
                                : needsSetup
                                  ? t('ai_chat.no_key', {
                                        defaultValue: 'No API key configured',
                                    })
                                  : t('ai_chat.select_model', {
                                        defaultValue: 'Select a model to start',
                                    })}
                        </SheetDescription>
                    </div>
                    <div className="flex items-center gap-1">
                        <ChatCostMeter />
                        {state.messages.length > 0 && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8"
                                        onClick={clear}
                                        aria-label={t('ai_chat.clear', {
                                            defaultValue: 'Clear chat',
                                        })}
                                    >
                                        <Trash2 className="size-3.5" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    {t('ai_chat.clear', {
                                        defaultValue: 'Clear chat',
                                    })}
                                </TooltipContent>
                            </Tooltip>
                        )}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    onClick={openAISettingsDialog}
                                    aria-label={t('ai_chat.settings', {
                                        defaultValue: 'AI settings',
                                    })}
                                >
                                    <Settings className="size-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {t('ai_chat.settings', {
                                    defaultValue: 'AI settings',
                                })}
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </SheetHeader>

                {error && <ErrorBanner message={error.message} />}

                {!ready && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <Sparkles className="size-10 text-amber-500" />
                        <h3 className="text-base font-semibold">
                            {t('ai_chat.setup_title', {
                                defaultValue: 'Set up your AI assistant',
                            })}
                        </h3>
                        <p className="max-w-xs text-sm text-muted-foreground">
                            {t('ai_chat.setup_body', {
                                defaultValue:
                                    'Add an OpenAI, Anthropic, or Google API key to start chatting with your schema.',
                            })}
                        </p>
                        <Button onClick={openAISettingsDialog}>
                            <Settings className="me-2 size-4" />
                            {t('ai_chat.open_settings', {
                                defaultValue: 'Open settings',
                            })}
                        </Button>
                    </div>
                )}

                {ready && (
                    <ChatMessages
                        messages={state.messages}
                        streaming={state.streaming}
                        isBusy={state.isBusy}
                    />
                )}

                <ChatApprovalCard />
                {ready && <ChatComposer disabled={!!state.pendingApproval} />}
            </SheetContent>
        </Sheet>
    );
};

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
    <div
        className={cn(
            'flex items-start gap-2 border-b border-red-500/40 bg-red-500/5 px-4 py-2 text-xs text-red-600 dark:text-red-400'
        )}
    >
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 break-words">{message}</p>
    </div>
);
