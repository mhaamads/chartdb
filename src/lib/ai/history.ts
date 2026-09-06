import type { AIContentBlock, AIMessage } from './types';

/** Repair interrupted/legacy history without ever replaying a mutation. */
export function repairToolHistory(messages: AIMessage[]): AIMessage[] {
    const out: AIMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === 'tool') continue;
        out.push(message);
        if (message.role !== 'assistant') continue;
        const calls = message.content.filter((b) => b.type === 'tool_use');
        if (!calls.length) continue;
        const next = messages[i + 1];
        const results = next?.role === 'tool' ? next.content : [];
        const content: AIContentBlock[] = calls.map(
            (call) =>
                results.find(
                    (b) =>
                        b.type === 'tool_result' &&
                        b.toolUseId === call.toolUseId
                ) ?? {
                    type: 'tool_result',
                    toolUseId: call.toolUseId,
                    isError: true,
                    result: {
                        error: 'This tool call was interrupted; its outcome is unknown.',
                        hint: 'Inspect the diagram before making further changes. Do not replay this call blindly.',
                    },
                }
        );
        out.push({
            id: next?.role === 'tool' ? next.id : `${message.id}-interrupted`,
            role: 'tool',
            content,
            createdAt: next?.createdAt ?? message.createdAt,
        });
        if (next?.role === 'tool') i++;
    }
    return out;
}

/** Cut only at user-turn boundaries, never between a call and its result. */
export function capChatHistory(
    messages: AIMessage[],
    limit: number
): AIMessage[] {
    if (messages.length <= limit) return messages;
    const start = messages.findIndex(
        (m, i) => i >= messages.length - limit && m.role === 'user'
    );
    // ponytail: retain a single oversized turn intact; token budgeting rejects
    // it explicitly if it cannot fit, instead of corrupting tool history.
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    return messages.slice(start < 0 ? Math.max(0, lastUser) : start);
}
