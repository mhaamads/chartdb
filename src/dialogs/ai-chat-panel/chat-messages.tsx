import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import type { AIMessage, AIContentBlock } from '@/lib/ai/types';
import { Loader2, Wrench, AlertTriangle, Sparkles } from 'lucide-react';
import { useAIChat } from '@/hooks/use-ai-chat';

interface ChatMessagesProps {
    messages: AIMessage[];
    streaming: AIMessage | null;
    isBusy: boolean;
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({
    messages,
    streaming,
    isBusy,
}) => {
    const scrollerRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new content.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, streaming?.content]);

    const rendered = streaming ? [...messages, streaming] : messages;

    if (rendered.length === 0) {
        return <EmptyState />;
    }

    return (
        <div
            ref={scrollerRef}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-3"
        >
            {rendered.map((m, i) => (
                <MessageRow
                    key={m.id}
                    message={m}
                    isStreaming={
                        isBusy &&
                        streaming?.id === m.id &&
                        i === rendered.length - 1
                    }
                />
            ))}
        </div>
    );
};

const EXAMPLE_PROMPTS = [
    'ai_chat.example_1',
    'ai_chat.example_2',
    'ai_chat.example_3',
] as const;

const EXAMPLE_DEFAULTS = [
    'Add a users table with id, email, name, and timestamps',
    'Create a relationship between customers and orders',
    'Suggest indexes for better query performance',
];

const EmptyState: React.FC = () => {
    const { t } = useTranslation();
    const { send } = useAIChat();

    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-amber-500/10">
                <Sparkles className="size-7 text-amber-500" />
            </div>
            <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                    {t('ai_chat.empty_title', {
                        defaultValue: 'Your AI schema assistant',
                    })}
                </p>
                <p className="max-w-xs text-xs text-muted-foreground">
                    {t('ai_chat.empty_state', {
                        defaultValue:
                            'Ask the assistant to design tables, suggest indexes, or explain your schema.',
                    })}
                </p>
            </div>
            <div className="flex w-full max-w-xs flex-col items-stretch gap-1.5">
                {EXAMPLE_PROMPTS.map((key, i) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => void send(EXAMPLE_DEFAULTS[i])}
                        className={cn(
                            'rounded-lg border border-border bg-background px-3 py-2',
                            'text-xs text-muted-foreground hover:border-amber-500/50 hover:bg-amber-500/5 hover:text-foreground',
                            'text-start transition-colors'
                        )}
                    >
                        {t(key, { defaultValue: EXAMPLE_DEFAULTS[i] })}
                    </button>
                ))}
            </div>
        </div>
    );
};

const MessageRow: React.FC<{ message: AIMessage; isStreaming: boolean }> = ({
    message,
    isStreaming,
}) => {
    if (message.role === 'tool') {
        // Tool result messages stay collapsed by default.
        return <ToolResultsRow message={message} />;
    }

    const isUser = message.role === 'user';
    return (
        <div
            className={cn(
                'flex flex-col gap-2',
                isUser ? 'items-end' : 'items-start'
            )}
        >
            {message.content.map((block, idx) => (
                <BlockView
                    key={idx}
                    block={block}
                    role={message.role}
                    isStreaming={
                        isStreaming && idx === message.content.length - 1
                    }
                />
            ))}
            {isStreaming && message.content.length === 0 && (
                <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Thinking…
                </div>
            )}
        </div>
    );
};

const BlockView: React.FC<{
    block: AIContentBlock;
    role: AIMessage['role'];
    isStreaming: boolean;
}> = ({ block, role, isStreaming }) => {
    if (block.type === 'text') {
        const isUser = role === 'user';
        return (
            <div
                className={cn(
                    'max-w-[85%] break-words rounded-lg px-3 py-2 text-sm leading-relaxed',
                    isUser
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground'
                )}
            >
                {isUser ? (
                    <span className="whitespace-pre-wrap">{block.text}</span>
                ) : (
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            p: ({ children }) => (
                                <p className="mb-1.5 last:mb-0">{children}</p>
                            ),
                            code: ({
                                children,
                                className,
                            }: React.ComponentProps<'code'>) => {
                                const isBlock =
                                    className?.startsWith('language-');
                                return isBlock ? (
                                    <code className="block">{children}</code>
                                ) : (
                                    <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">
                                        {children}
                                    </code>
                                );
                            },
                            pre: ({ children }) => (
                                <pre className="my-1.5 overflow-auto rounded-md bg-black/10 p-2.5 font-mono text-[11px] leading-normal dark:bg-white/10">
                                    {children}
                                </pre>
                            ),
                            ul: ({ children }) => (
                                <ul className="mb-1.5 ms-4 list-disc space-y-0.5">
                                    {children}
                                </ul>
                            ),
                            ol: ({ children }) => (
                                <ol className="mb-1.5 ms-4 list-decimal space-y-0.5">
                                    {children}
                                </ol>
                            ),
                            strong: ({ children }) => (
                                <strong className="font-semibold">
                                    {children}
                                </strong>
                            ),
                            a: ({ href, children }) => (
                                <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 opacity-80 hover:opacity-100"
                                >
                                    {children}
                                </a>
                            ),
                        }}
                    >
                        {block.text}
                    </ReactMarkdown>
                )}
                {isStreaming && (
                    <span className="ms-1 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
                )}
            </div>
        );
    }
    if (block.type === 'tool_use') {
        const displayName = block.name
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
        return (
            <div className="flex w-full max-w-[85%] items-center gap-2 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-1.5 text-xs text-muted-foreground">
                <Wrench className="size-3 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate">{displayName}</span>
                {isStreaming && (
                    <Loader2 className="ms-auto size-3 shrink-0 animate-spin text-amber-500" />
                )}
            </div>
        );
    }
    return null;
};

const ToolResultsRow: React.FC<{ message: AIMessage }> = ({ message }) => {
    const errored = message.content.some(
        (b) => b.type === 'tool_result' && b.isError
    );
    return (
        <div className="flex items-start">
            <div
                className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-1 text-xs',
                    errored
                        ? 'bg-red-500/10 text-red-500'
                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                )}
            >
                {errored ? (
                    <AlertTriangle className="size-3" />
                ) : (
                    <Wrench className="size-3" />
                )}
                {message.content.length === 1
                    ? errored
                        ? 'Tool error'
                        : 'Tool result'
                    : `${message.content.length} tool results${
                          errored ? ' (with errors)' : ''
                      }`}
            </div>
        </div>
    );
};
