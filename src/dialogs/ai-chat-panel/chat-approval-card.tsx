import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button/button';
import { useAIChat } from '@/hooks/use-ai-chat';
import {
    AlertTriangle,
    Check,
    X,
    ChevronDown,
    ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

function formatArgs(args: unknown): string {
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        return String(args);
    }
}

export const ChatApprovalCard: React.FC = () => {
    const { t } = useTranslation();
    const { pendingApproval, resolveApproval } = useAIChat();
    const [expanded, setExpanded] = useState(false);
    if (!pendingApproval) return null;

    const { request } = pendingApproval;
    const argsJson = formatArgs(request.args);
    const hasArgs = argsJson && argsJson !== '{}' && argsJson !== 'null';

    return (
        <div className="border-t border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-medium text-foreground">
                            {t('ai_chat.approve_title', {
                                defaultValue: 'Approve action',
                            })}
                        </div>
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
                            {request.toolName}
                        </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {request.summary}
                    </p>
                    {hasArgs && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setExpanded((v) => !v)}
                                className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                            >
                                {expanded ? (
                                    <ChevronDown className="size-3" />
                                ) : (
                                    <ChevronRight className="size-3" />
                                )}
                                {expanded
                                    ? t('ai_chat.hide_args', {
                                          defaultValue: 'Hide arguments',
                                      })
                                    : t('ai_chat.show_args', {
                                          defaultValue: 'Show arguments',
                                      })}
                            </button>
                            {expanded && (
                                <pre
                                    className={cn(
                                        'mt-1 max-h-40 overflow-auto rounded border border-border bg-background/60 p-2',
                                        'font-mono text-[10px] leading-snug text-muted-foreground'
                                    )}
                                >
                                    {argsJson}
                                </pre>
                            )}
                        </div>
                    )}
                    <div className="flex gap-2 pt-1">
                        <Button
                            size="sm"
                            variant="default"
                            onClick={() => resolveApproval(true)}
                            className="h-7 gap-1 px-2 text-xs"
                        >
                            <Check className="size-3" />
                            {t('ai_chat.apply', { defaultValue: 'Apply' })}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => resolveApproval(false)}
                            className="h-7 gap-1 px-2 text-xs"
                        >
                            <X className="size-3" />
                            {t('ai_chat.reject', { defaultValue: 'Reject' })}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
