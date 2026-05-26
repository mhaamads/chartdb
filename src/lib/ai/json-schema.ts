/**
 * Bridges Zod schemas to the JSON Schema dialect that LLM providers accept.
 *
 * All three providers (OpenAI, Anthropic, Gemini) accept a *subset* of
 * JSON Schema 7. The common subset we target is:
 *   - `type`, `properties`, `required`, `enum`, `items`, `additionalProperties`
 *   - `description`, no `$ref` (providers reject deep refs)
 *
 * We default to `target: 'openApi3'` which inlines refs and is the most
 * forgiving across providers.
 */

import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AIToolJSONSchema } from './types';

export function zodToToolSchema(schema: ZodTypeAny): AIToolJSONSchema {
    const raw = zodToJsonSchema(schema, {
        target: 'openApi3',
        $refStrategy: 'none',
    }) as Record<string, unknown>;
    // The openApi3 target wraps the schema in a top-level object — flatten
    // it so providers get the exact shape they expect.
    // Strip any draft pointers that some providers reject.
    delete raw.$schema;
    delete raw.definitions;
    return raw as AIToolJSONSchema;
}
