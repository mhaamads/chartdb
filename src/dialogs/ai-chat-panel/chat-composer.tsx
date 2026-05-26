import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button/button';
import { Textarea } from '@/components/textarea/textarea';
import { Send, Square, Loader2 } from 'lucide-react';
import { useAIChat } from '@/hooks/use-ai-chat';

export const ChatComposer: React.FC<{ disabled?: boolean }> = ({
    disabled,
}) => {
    const { t } = useTranslation();
    const { send, abort, state, ready } = useAIChat();
    const [text, setText] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const busy = state.isBusy;
    const canSend = ready && text.trim().length > 0 && !busy && !disabled;

    // Auto-grow textarea up to ~6 lines.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
    }, [text]);

    const handleSubmit = async (): Promise<void> => {
        if (!canSend) return;
        const value = text.trim();
        setText('');
        try {
            await send(value);
        } catch {
            // error surfaces via state.error
        }
    };

    return (
        <div className="border-t border-border bg-background p-3">
            <div className="flex items-end gap-2">
                <Textarea
                    ref={textareaRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleSubmit();
                        }
                    }}
                    placeholder={
                        ready
                            ? t('ai_chat.placeholder', {
                                  defaultValue:
                                      'Describe a change, ask a question…',
                              })
                            : t('ai_chat.placeholder_no_key', {
                                  defaultValue:
                                      'Configure an AI provider to start chatting.',
                              })
                    }
                    disabled={!ready || disabled}
                    rows={1}
                    className="max-h-36 min-h-[40px] flex-1 resize-none py-2 text-sm"
                />
                {busy ? (
                    <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        onClick={abort}
                        aria-label={t('ai_chat.stop', {
                            defaultValue: 'Stop generating',
                        })}
                    >
                        <Square className="size-4" />
                    </Button>
                ) : (
                    <Button
                        type="button"
                        size="icon"
                        onClick={() => void handleSubmit()}
                        disabled={!canSend}
                        aria-label={t('ai_chat.send', {
                            defaultValue: 'Send message',
                        })}
                    >
                        {state.status === 'streaming' ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Send className="size-4" />
                        )}
                    </Button>
                )}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
                {t('ai_chat.hint', {
                    defaultValue: 'Enter to send, Shift+Enter for newline.',
                })}
            </p>
        </div>
    );
};
