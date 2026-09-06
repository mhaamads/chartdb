/**
 * Chat session — the runtime that orchestrates a conversation.
 *
 * Responsibilities:
 *   - Hold the immutable message log + a partially-streaming "draft" message.
 *   - Drive the provider adapter loop: send → stream → if tool_use → execute
 *     tools → send tool_result → loop. Up to `maxIterations` rounds per turn.
 *   - Validate tool args with Zod via the executor wrapper inside tools.ts.
 *   - Track usage + cost per turn for the UI cost meter.
 *   - Honour cancellation (AbortController.signal) at every async boundary.
 *
 * This module is framework-agnostic. The React glue lives in
 * `use-ai-chat.ts` which subscribes to the store and exposes ergonomic
 * methods to components.
 */

import type {
    AIContentBlock,
    AIError,
    AIMessage,
    AIProvider,
    AIProviderAdapter,
    AISafetyMode,
    AIToolContext,
    AIToolDefinition,
    AITokenUsage,
    ApprovalRequest,
} from './types';
import { estimateCost, getModel } from './models';
import { isLocalProvider } from './types';
import { repairToolHistory } from './history';
import { generateId } from '@/lib/utils/utils';

/** Rough token estimate: ~4 characters per token for English text. */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Estimate tokens in a single message (content blocks serialized). */
function estimateMessageTokens(msg: AIMessage): number {
    let chars = 0;
    for (const block of msg.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'tool_use')
            chars +=
                JSON.stringify(block.args ?? null).length + block.name.length;
        else if (block.type === 'tool_result')
            chars += JSON.stringify(block.result ?? null).length;
    }
    chars += JSON.stringify(msg.geminiParts ?? []).length;
    return Math.ceil(chars / 4);
}

export type ChatStatus =
    | 'idle'
    | 'streaming'
    | 'executing-tool'
    | 'awaiting-approval'
    | 'error';

export interface PendingApproval {
    request: ApprovalRequest;
    resolve: (approved: boolean) => void;
}

export interface ChatTurnUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** USD, computed from the active model's pricing. */
    cost: number;
}

export interface ChatState {
    messages: AIMessage[];
    status: ChatStatus;
    /** Partial assistant message currently being streamed, if any. */
    streaming: AIMessage | null;
    /** Most recent error (cleared on next send). */
    error: AIError | null;
    /** Aggregated usage across all turns in this session. */
    totalUsage: ChatTurnUsage;
    /** Usage from the most recent completed turn. */
    lastTurnUsage: ChatTurnUsage | null;
    /** Approval request blocking the current turn (when applicable). */
    pendingApproval: PendingApproval | null;
    /** True while a turn is active (sending or tool-executing). */
    isBusy: boolean;
}

const EMPTY_USAGE: ChatTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
};

export interface ChatSessionOptions {
    provider: AIProvider;
    model: string;
    getApiKey: () => string | undefined;
    /**
     * Optional base URL accessor — used by OpenAI-compatible providers
     * like LM Studio. Returning undefined falls back to the adapter's
     * own default (the public OpenAI/LM Studio default endpoint).
     */
    getBaseUrl?: () => string | undefined;
    getSystemPrompt: () => string;
    /** Snapshot of the tool catalog (already bound). */
    tools: AIToolDefinition[];
    /** Tool execution context (chartdb, signal injected per turn). */
    buildToolContext: (signal: AbortSignal) => Omit<AIToolContext, 'signal'>;
    adapter: AIProviderAdapter;
    temperature: number;
    maxOutputTokens: number;
    /** Cap on assistant ↔ tool round-trips per user message. */
    maxIterations: number;
    /** Safety mode — controls approval prompts. */
    getSafetyMode?: () => AISafetyMode;
    requiresApproval: (tool: AIToolDefinition, args: unknown) => boolean;
    /** Called when the session state changes. */
    onChange?: (state: ChatState) => void;
    /** Optional initial messages (e.g. when rehydrating from Firestore). */
    initialMessages?: AIMessage[];
    /** Optional initial usage totals (when rehydrating). */
    initialTotalUsage?: ChatTurnUsage;
}

type Listener = (state: ChatState) => void;

export class ChatSession {
    private state: ChatState;
    private listeners = new Set<Listener>();
    private generation = 0;
    private abortController: AbortController | null = null;

    constructor(private opts: ChatSessionOptions) {
        this.state = {
            messages: repairToolHistory(opts.initialMessages ?? []),
            status: 'idle',
            streaming: null,
            error: null,
            totalUsage: opts.initialTotalUsage ?? { ...EMPTY_USAGE },
            lastTurnUsage: null,
            pendingApproval: null,
            isBusy: false,
        };
        if (opts.onChange) this.listeners.add(opts.onChange);
    }

    // -------------------------------------------------------------------
    // Subscriptions
    // -------------------------------------------------------------------

    getState(): ChatState {
        return this.state;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private setState(patch: Partial<ChatState>): void {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners) l(this.state);
    }

    // -------------------------------------------------------------------
    // Public commands
    // -------------------------------------------------------------------

    async send(text: string): Promise<void> {
        if (this.state.isBusy) {
            throw new Error('Session is already running.');
        }
        if (!text.trim()) return;
        const userMessage: AIMessage = {
            id: generateId(),
            role: 'user',
            content: [{ type: 'text', text }],
            createdAt: Date.now(),
        };
        this.setState({
            messages: [...this.state.messages, userMessage],
            error: null,
            lastTurnUsage: null,
        });
        await this.runTurn();
    }

    abort(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
        if (this.state.pendingApproval) {
            this.state.pendingApproval.resolve(false);
            this.setState({ pendingApproval: null });
        }
    }

    resolveApproval(approved: boolean): void {
        const pending = this.state.pendingApproval;
        if (!pending) return;
        pending.resolve(approved);
        this.setState({ pendingApproval: null });
    }

    clear(): void {
        this.abort();
        this.generation++;
        this.abortController = null;
        this.setState({
            messages: [],
            streaming: null,
            error: null,
            totalUsage: { ...EMPTY_USAGE },
            lastTurnUsage: null,
            status: 'idle',
            isBusy: false,
            pendingApproval: null,
        });
    }

    setMessages(messages: AIMessage[]): void {
        if (this.state.isBusy) throw new Error('Session is already running.');
        this.setState({ messages: repairToolHistory(messages) });
    }

    updateOptions(patch: Partial<ChatSessionOptions>): void {
        this.opts = { ...this.opts, ...patch };
    }

    // -------------------------------------------------------------------
    // Turn loop
    // -------------------------------------------------------------------

    /**
     * Prune old messages when the conversation approaches the model's
     * context window. Always keeps the most recent user message and any
     * tool messages that belong to the same turn. Drops oldest
     * assistant/user pairs first.
     */
    private pruneMessages(
        system: string,
        tools: AIToolDefinition[]
    ): AIMessage[] {
        const model = getModel(this.opts.model);
        if (!model) return this.state.messages;
        const overhead =
            estimateTokens(system) +
            estimateTokens(
                JSON.stringify(
                    tools.map(({ name, description, inputSchema }) => ({
                        name,
                        description,
                        inputSchema,
                    }))
                )
            );
        const budget =
            Math.floor(model.contextWindow * 0.9) -
            Math.min(this.opts.maxOutputTokens, model.maxOutputTokens) -
            overhead;
        const messages = this.state.messages;
        let used = messages.reduce(
            (sum, m) => sum + estimateMessageTokens(m),
            0
        );
        let start = 0;
        while (used > budget) {
            const next = messages.findIndex(
                (m, i) => i > start && m.role === 'user'
            );
            if (next < 0) {
                throw new Error(
                    'The current turn and diagram exceed the model context window. Start a new chat or use a larger-context model.'
                );
            }
            for (let i = start; i < next; i++)
                used -= estimateMessageTokens(messages[i]);
            start = next;
        }
        return messages.slice(start);
    }

    private async runTurn(): Promise<void> {
        const apiKey = this.opts.getApiKey() ?? '';
        const localOk = isLocalProvider(this.opts.provider);
        if (!apiKey && !localOk) {
            this.setState({
                error: {
                    code: 'auth',
                    message: 'No API key configured for the selected provider.',
                },
                status: 'error',
            });
            return;
        }

        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const generation = this.generation;
        const turnUsage: ChatTurnUsage = { ...EMPTY_USAGE };

        this.setState({ isBusy: true, status: 'streaming', error: null });

        try {
            if (
                !Number.isSafeInteger(this.opts.maxIterations) ||
                this.opts.maxIterations < 1 ||
                !Number.isSafeInteger(this.opts.maxOutputTokens) ||
                this.opts.maxOutputTokens < 1 ||
                !Number.isFinite(this.opts.temperature) ||
                this.opts.temperature < 0 ||
                this.opts.temperature > 2
            ) {
                throw new Error(
                    'Invalid AI settings. Use positive whole-number token and iteration limits, and a temperature between 0 and 2.'
                );
            }
            for (let iter = 0; iter < this.opts.maxIterations; iter++) {
                if (signal.aborted) break;

                const streaming = await this.streamAssistantMessage(
                    apiKey,
                    signal,
                    turnUsage
                );
                if (generation !== this.generation) return;
                if (!streaming || signal.aborted) break; // error already set

                // Commit the streamed message to history.
                this.setState({
                    messages: [...this.state.messages, streaming],
                    streaming: null,
                });

                const toolUses = streaming.content.filter(
                    (b): b is Extract<AIContentBlock, { type: 'tool_use' }> =>
                        b.type === 'tool_use'
                );
                if (toolUses.length === 0) break;

                // Execute tools sequentially. Each failure is reported as an
                // `isError: true` tool_result so the model can self-correct.
                this.setState({ status: 'executing-tool' });
                const toolResults: AIContentBlock[] = [];
                for (const call of toolUses) {
                    const result: AIContentBlock = signal.aborted
                        ? {
                              type: 'tool_result',
                              toolUseId: call.toolUseId,
                              isError: true,
                              result: { error: 'Cancelled before execution.' },
                          }
                        : await this.executeTool(call, signal);
                    if (generation !== this.generation) return;
                    toolResults.push(result);
                }
                const toolMessage: AIMessage = {
                    id: generateId(),
                    role: 'tool',
                    content: toolResults,
                    createdAt: Date.now(),
                };
                this.setState({
                    messages: [...this.state.messages, toolMessage],
                    status: 'streaming',
                });
                if (!signal.aborted && iter === this.opts.maxIterations - 1) {
                    this.setState({
                        status: 'error',
                        error: {
                            code: 'invalid_request',
                            message:
                                'Tool round limit reached. Completed changes are retained; review them before continuing.',
                        },
                    });
                }
            }
        } catch (err) {
            if (!signal.aborted && generation === this.generation) {
                this.setState({
                    error: {
                        code:
                            err instanceof Error &&
                            err.message.includes('context window')
                                ? 'context_length'
                                : 'unknown',
                        message:
                            err instanceof Error ? err.message : String(err),
                    },
                    status: 'error',
                });
            }
        } finally {
            if (generation === this.generation) {
                // Aggregate session usage.
                const total = this.state.totalUsage;
                const newTotal: ChatTurnUsage = {
                    inputTokens: total.inputTokens + turnUsage.inputTokens,
                    outputTokens: total.outputTokens + turnUsage.outputTokens,
                    cachedInputTokens:
                        total.cachedInputTokens + turnUsage.cachedInputTokens,
                    cost: total.cost + turnUsage.cost,
                };
                this.setState({
                    isBusy: false,
                    status: signal.aborted
                        ? 'idle'
                        : this.state.status === 'error'
                          ? 'error'
                          : 'idle',
                    streaming: null,
                    pendingApproval: null,
                    lastTurnUsage: turnUsage,
                    totalUsage: newTotal,
                });
                this.abortController = null;
            }
        }
    }

    // -------------------------------------------------------------------
    // Stream + assemble one assistant message
    // -------------------------------------------------------------------

    private async streamAssistantMessage(
        apiKey: string,
        signal: AbortSignal,
        turnUsage: ChatTurnUsage
    ): Promise<AIMessage | null> {
        const messageId = generateId();
        const draft: AIMessage = {
            id: messageId,
            role: 'assistant',
            content: [],
            createdAt: Date.now(),
            model: this.opts.model,
        };
        this.setState({ streaming: draft });

        // Working state during stream.
        const blocks: AIContentBlock[] = [];
        let currentTextIdx: number | null = null;
        const toolIdxById = new Map<string, number>();
        const completedTools = new Set<string>();

        const commit = (): void => {
            this.setState({
                streaming: { ...draft, content: [...blocks] },
            });
        };

        const system = this.opts.getSystemPrompt();
        const tools =
            this.opts.getSafetyMode?.() === 'dry-run'
                ? this.opts.tools.filter((t) => t.readOnly)
                : this.opts.tools;
        const messages = this.pruneMessages(system, tools);
        const stream = this.opts.adapter.stream(
            {
                apiKey,
                baseUrl: this.opts.getBaseUrl?.(),
                model: this.opts.model,
                system,
                messages,
                tools,
                temperature: this.opts.temperature,
                maxOutputTokens: Math.min(
                    this.opts.maxOutputTokens,
                    getModel(this.opts.model)?.maxOutputTokens ??
                        this.opts.maxOutputTokens
                ),
            },
            signal
        );

        for await (const ev of stream) {
            if (signal.aborted) return null;
            switch (ev.type) {
                case 'message-start':
                    if (ev.model) draft.model = ev.model;
                    break;
                case 'gemini-parts':
                    draft.geminiParts = [
                        ...(draft.geminiParts ?? []),
                        ...ev.parts,
                    ];
                    break;
                case 'text-delta': {
                    if (currentTextIdx === null) {
                        blocks.push({ type: 'text', text: ev.text });
                        currentTextIdx = blocks.length - 1;
                    } else {
                        const cur = blocks[currentTextIdx];
                        if (cur.type === 'text') cur.text += ev.text;
                    }
                    commit();
                    break;
                }
                case 'tool-use-start': {
                    if (toolIdxById.has(ev.toolUseId))
                        throw new Error(
                            'Duplicate tool call id received. No tools were executed.'
                        );
                    currentTextIdx = null;
                    blocks.push({
                        type: 'tool_use',
                        toolUseId: ev.toolUseId,
                        name: ev.name,
                        args: {},
                    });
                    toolIdxById.set(ev.toolUseId, blocks.length - 1);
                    commit();
                    break;
                }
                case 'tool-use-delta':
                    // We intentionally do not display partial args mid-stream.
                    break;
                case 'tool-use-end': {
                    const idx = toolIdxById.get(ev.toolUseId);
                    if (idx !== undefined) {
                        const cur = blocks[idx];
                        if (cur.type === 'tool_use') cur.args = ev.args;
                        completedTools.add(ev.toolUseId);
                    }
                    commit();
                    break;
                }
                case 'usage': {
                    turnUsage.inputTokens += ev.usage.inputTokens;
                    turnUsage.outputTokens += ev.usage.outputTokens;
                    turnUsage.cachedInputTokens +=
                        ev.usage.cachedInputTokens ?? 0;
                    const model = getModel(this.opts.model);
                    if (model) {
                        turnUsage.cost += estimateCost(
                            model.id,
                            ev.usage.inputTokens,
                            ev.usage.outputTokens
                        );
                    }
                    draft.usage = mergeUsage(draft.usage, ev.usage);
                    commit();
                    break;
                }
                case 'message-end':
                    if (ev.stopReason === 'aborted') return null;
                    if (
                        !ev.stopReason ||
                        ev.stopReason === 'max_tokens' ||
                        ev.stopReason === 'error' ||
                        completedTools.size !== toolIdxById.size ||
                        blocks.length === 0
                    ) {
                        throw new Error(
                            ev.stopReason === 'max_tokens'
                                ? 'The model reached its output limit. No tools from this response were executed. Increase the output limit or request a smaller change.'
                                : 'The provider returned an incomplete response. No tools from this response were executed.'
                        );
                    }
                    return { ...draft, content: blocks };
                case 'error':
                    this.setState({
                        error: ev.error,
                        status: 'error',
                        streaming: null,
                    });
                    return null;
            }
        }
        if (signal.aborted) return null;
        throw new Error(
            'The response stream ended unexpectedly. No tools from this response were executed.'
        );
    }

    // -------------------------------------------------------------------
    // Tool execution
    // -------------------------------------------------------------------

    private async executeTool(
        call: Extract<AIContentBlock, { type: 'tool_use' }>,
        signal: AbortSignal
    ): Promise<AIContentBlock> {
        const tool = this.opts.tools.find((t) => t.name === call.name);
        if (!tool) {
            return {
                type: 'tool_result',
                toolUseId: call.toolUseId,
                isError: true,
                result: {
                    error: `Unknown tool "${call.name}".`,
                    hint: 'Pick from the tools listed in this session.',
                },
            };
        }

        try {
            signal.throwIfAborted();
            tool.validateArgs?.(call.args);
            const baseCtx = this.opts.buildToolContext(signal);
            const assertCanWrite = () => {
                signal.throwIfAborted();
                if (this.opts.getSafetyMode?.() === 'dry-run')
                    throw new Error('Writes are disabled in dry-run mode.');
                if (baseCtx.chartdb?.readonly)
                    throw new Error('This diagram is read-only.');
            };
            if (!tool.readOnly) assertCanWrite();
            if (this.opts.requiresApproval(tool, call.args)) {
                const approved = await this.requestApproval({
                    toolName: tool.name,
                    args: call.args,
                    summary: `Run ${tool.name}`,
                });
                if (!approved)
                    throw new Error(
                        'User declined the operation. Do not retry it.'
                    );
            }
            signal.throwIfAborted();
            if (!tool.readOnly) assertCanWrite();
            const ctx: AIToolContext = {
                ...baseCtx,
                get chartdb() {
                    return baseCtx.chartdb;
                },
                signal,
                assertCanWrite,
                // Approval is enforced once above for every tool, including batches.
                requestApproval: undefined,
            };
            this.setState({ status: 'executing-tool' });
            const result = await tool.execute(call.args, ctx);
            // Keep invalid/non-serializable results from poisoning later requests.
            JSON.stringify(result ?? null);
            return {
                type: 'tool_result',
                toolUseId: call.toolUseId,
                result: result ?? null,
                isError: !!(
                    result &&
                    typeof result === 'object' &&
                    'error' in result
                ),
            };
        } catch (err) {
            const error = err as
                | (Error & { hint?: string; details?: unknown })
                | null;
            return {
                type: 'tool_result',
                toolUseId: call.toolUseId,
                isError: true,
                result: {
                    error: error?.message ?? String(err),
                    hint: error?.hint,
                    details: error?.details,
                },
            };
        }
    }

    private requestApproval(request: ApprovalRequest): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.setState({
                pendingApproval: { request, resolve },
                status: 'awaiting-approval',
            });
        });
    }
}

function mergeUsage(
    prev: AITokenUsage | undefined,
    next: AITokenUsage
): AITokenUsage {
    if (!prev) return next;
    return {
        inputTokens: prev.inputTokens + next.inputTokens,
        outputTokens: prev.outputTokens + next.outputTokens,
        cachedInputTokens:
            (prev.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    };
}
