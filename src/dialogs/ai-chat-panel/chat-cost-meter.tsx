import React from 'react';
import { useAIChat } from '@/hooks/use-ai-chat';
import { useAIConfig } from '@/hooks/use-ai-config';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { Sigma } from 'lucide-react';

function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(cost: number): string {
    if (cost < 0.001) return '<$0.001';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
}

export const ChatCostMeter: React.FC = () => {
    const { state } = useAIChat();
    const { showCost } = useAIConfig();
    const { totalUsage, lastTurnUsage } = state;

    if (!showCost) return null;
    if (totalUsage.inputTokens === 0 && totalUsage.outputTokens === 0)
        return null;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    <Sigma className="size-3" />
                    <span>{formatCost(totalUsage.cost)}</span>
                    <span className="text-foreground/40">·</span>
                    <span>
                        {formatTokens(
                            totalUsage.inputTokens + totalUsage.outputTokens
                        )}{' '}
                        tok
                    </span>
                </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <div className="space-y-1 text-xs">
                    <div className="font-medium">Session usage</div>
                    <div>
                        Input: {formatTokens(totalUsage.inputTokens)} · Output:{' '}
                        {formatTokens(totalUsage.outputTokens)}
                    </div>
                    {totalUsage.cachedInputTokens > 0 && (
                        <div>
                            Cached: {formatTokens(totalUsage.cachedInputTokens)}
                        </div>
                    )}
                    {lastTurnUsage && (
                        <div className="border-t border-border pt-1 text-muted-foreground">
                            Last turn: {formatCost(lastTurnUsage.cost)} ·{' '}
                            {formatTokens(
                                lastTurnUsage.inputTokens +
                                    lastTurnUsage.outputTokens
                            )}{' '}
                            tok
                        </div>
                    )}
                </div>
            </TooltipContent>
        </Tooltip>
    );
};
