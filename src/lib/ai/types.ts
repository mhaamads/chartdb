/**
 * Shared types for the multi-provider AI assistant subsystem.
 *
 * All provider-specific SDKs are kept behind the `AIProviderAdapter`
 * interface so the rest of the app never imports an OpenAI / Anthropic /
 * Gemini SDK directly. This keeps bundle splitting easy (each adapter is a
 * dynamic import) and means new providers can be added without touching
 * the UI or executor.
 */

import type { ChartDBContext } from '@/context/chartdb-context/chartdb-context';

// ---------------------------------------------------------------------------
// Providers / models
// ---------------------------------------------------------------------------

export const AI_PROVIDERS = [
    'openai',
    'anthropic',
    'gemini',
    'deepseek',
    'lmstudio',
] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

/** Providers that run locally and don't strictly require an API key. */
export const LOCAL_AI_PROVIDERS: ReadonlyArray<AIProvider> = ['lmstudio'];

export function isLocalProvider(provider: AIProvider): boolean {
    return LOCAL_AI_PROVIDERS.includes(provider);
}

export interface AIModel {
    /** Provider-specific model identifier (sent verbatim to the API). */
    id: string;
    /** Friendly label shown in pickers. */
    label: string;
    provider: AIProvider;
    /** Maximum input context window in tokens. */
    contextWindow: number;
    /** Maximum output token cap supported by the model. */
    maxOutputTokens: number;
    /** Whether the model supports native tool / function calling. */
    supportsTools: boolean;
    /** USD per 1M input tokens (best-effort, used for cost meter). */
    inputCostPer1M: number;
    /** USD per 1M output tokens. */
    outputCostPer1M: number;
    /** Optional short description. */
    description?: string;
    /** True if this is the recommended default for the provider. */
    recommended?: boolean;
}

// ---------------------------------------------------------------------------
// Messages / content blocks
// ---------------------------------------------------------------------------

/** Role on a message. `tool` carries tool execution results. */
export type AIRole = 'system' | 'user' | 'assistant' | 'tool';

export type AIContentBlock =
    | { type: 'text'; text: string }
    | {
          type: 'tool_use';
          /** Provider-issued id linking a tool_use to its tool_result. */
          toolUseId: string;
          /** Tool name (matches `AIToolDefinition.name`). */
          name: string;
          /** Tool arguments object, already parsed (if streaming was complete). */
          args: unknown;
      }
    | {
          type: 'tool_result';
          toolUseId: string;
          /** Serialized result of executing the tool. */
          result: unknown;
          /** True when the tool executor threw or returned a structured error. */
          isError?: boolean;
      };

export interface AIMessage {
    /** Stable client-generated id (nanoid). */
    id: string;
    role: AIRole;
    /** Ordered list of content blocks. Always at least one entry. */
    content: AIContentBlock[];
    /** Wall-clock timestamp at message creation. */
    createdAt: number;
    /** Optional token usage attributed to this message (assistant only). */
    usage?: AITokenUsage;
    /** Model id that produced this message, if any. */
    model?: string;
}

export interface AITokenUsage {
    inputTokens: number;
    outputTokens: number;
    /** Some providers separately count cached / tool-call tokens. */
    cachedInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Lightweight JSON-Schema-ish shape consumed by all three providers.
 * We don't ship a full draft validator — the providers do the validation
 * server-side and we additionally validate with Zod before executing.
 */
export type AIToolJSONSchema = Record<string, unknown>;

export interface AIToolDefinition {
    name: string;
    description: string;
    /** JSON Schema describing the `args` object expected by `execute`. */
    inputSchema: AIToolJSONSchema;
    /** True for tools that modify or delete data. Gates approval flow. */
    destructive?: boolean;
    /**
     * Execute the tool against the live diagram. The executor wraps this in
     * try/catch and feeds errors back to the model as `tool_result` blocks
     * with `isError: true` so the model can self-correct.
     */
    execute: (args: unknown, ctx: AIToolContext) => Promise<unknown>;
}

export interface AIToolContext {
    /** The full ChartDB mutation surface (typed). */
    chartdb: ChartDBContext;
    /** Currently active diagram id. */
    diagramId: string;
    /** AbortSignal that fires when the user cancels the run. */
    signal: AbortSignal;
    /** Reports human-readable progress for the UI (e.g. "Created 3 tables"). */
    emitProgress?: (msg: string) => void;
    /**
     * Request user approval for a destructive op. Returns true on approve.
     * The executor decides whether to call this based on the safety mode.
     */
    requestApproval?: (summary: ApprovalRequest) => Promise<boolean>;
}

export interface ApprovalRequest {
    toolName: string;
    args: unknown;
    /** Short human-readable summary of what's about to happen. */
    summary: string;
}

// ---------------------------------------------------------------------------
// Streaming protocol
// ---------------------------------------------------------------------------

export type AIStreamEvent =
    | { type: 'message-start'; messageId: string; model?: string }
    | { type: 'text-delta'; text: string }
    | {
          type: 'tool-use-start';
          toolUseId: string;
          name: string;
      }
    | {
          type: 'tool-use-delta';
          toolUseId: string;
          /** Partial JSON fragment for the tool args. */
          argsDelta: string;
      }
    | {
          type: 'tool-use-end';
          toolUseId: string;
          /** Final parsed args object. */
          args: unknown;
      }
    | { type: 'usage'; usage: AITokenUsage }
    | { type: 'message-end'; stopReason?: AIStopReason }
    | { type: 'error'; error: AIError };

export type AIStopReason =
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'error'
    | 'aborted';

/**
 * Typed error categories. Adapters normalize provider errors into one of
 * these so the UI can react consistently (e.g. auth → open settings).
 */
export interface AIError {
    code:
        | 'auth'
        | 'rate_limit'
        | 'context_length'
        | 'content_filter'
        | 'invalid_request'
        | 'server'
        | 'network'
        | 'aborted'
        | 'unknown';
    message: string;
    /** Provider-specific status code if any. */
    status?: number;
    /** Provider-specific raw error code if any. */
    raw?: unknown;
}

// ---------------------------------------------------------------------------
// Request shape passed to adapters
// ---------------------------------------------------------------------------

export interface AIRequest {
    model: string;
    apiKey: string;
    /**
     * Optional per-request base URL override. Used for self-hosted /
     * OpenAI-compatible servers like LM Studio. Adapters that don't
     * understand it simply ignore the value.
     */
    baseUrl?: string;
    /** System prompt — adapters merge with provider-specific conventions. */
    system: string;
    messages: AIMessage[];
    tools: AIToolDefinition[];
    temperature: number;
    maxOutputTokens: number;
}

export interface AIProviderAdapter {
    readonly id: AIProvider;
    /**
     * Stream a completion. Implementations must respect `signal` and yield
     * a clean `aborted` `message-end` when cancelled mid-stream.
     */
    stream(req: AIRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent>;
}

// ---------------------------------------------------------------------------
// Safety / behavior
// ---------------------------------------------------------------------------

export type AISafetyMode = 'auto' | 'ask' | 'dry-run';
