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

/**
 * DeepSeek's tool validator rejects `anyOf`/`oneOf`, including the
 * discriminated union used by `apply_schema_patch`. Merge object branches
 * into one permissive object; Zod remains the runtime validator.
 */
export function sanitizeDeepSeekToolSchema(
    schema: AIToolJSONSchema
): AIToolJSONSchema {
    return sanitizeSchema(schema) as AIToolJSONSchema;
}

type SchemaObject = Record<string, unknown>;

function isSchemaObject(value: unknown): value is SchemaObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeSchema);
    if (!isSchemaObject(value)) return value;

    const unionKey = Array.isArray(value.anyOf)
        ? 'anyOf'
        : Array.isArray(value.oneOf)
          ? 'oneOf'
          : undefined;
    if (!unionKey) {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                sanitizeSchema(child),
            ])
        );
    }

    const branches = (value[unionKey] as unknown[]).map(sanitizeSchema);
    const base = Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== 'anyOf' && key !== 'oneOf')
            .map(([key, child]) => [key, sanitizeSchema(child)])
    );
    return mergeSchemaBranches(base, branches);
}

function mergeSchemaBranches(
    base: SchemaObject,
    branches: unknown[]
): SchemaObject {
    const objects = branches.filter(isSchemaObject);
    if (
        objects.length === branches.length &&
        objects.length > 0 &&
        objects.every((object) => object.type === 'object')
    ) {
        const properties: SchemaObject = {};
        for (const object of objects) {
            const objectProperties = isSchemaObject(object.properties)
                ? object.properties
                : {};
            for (const [key, schema] of Object.entries(objectProperties)) {
                const previous = properties[key];
                properties[key] = previous
                    ? mergeSchemaBranches({}, [previous, schema])
                    : schema;
            }
        }

        const requiredSets = objects.map(
            (object) =>
                new Set(
                    Array.isArray(object.required)
                        ? object.required.filter(
                              (key): key is string => typeof key === 'string'
                          )
                        : []
                )
        );
        const required = [...requiredSets[0]].filter((key) =>
            requiredSets.every((set) => set.has(key))
        );
        const additionalProperties = objects.map(
            (object) => object.additionalProperties
        );

        const merged: SchemaObject = {
            ...base,
            type: 'object',
            properties,
        };
        if (required.length > 0) merged.required = required;
        else delete merged.required;
        if (additionalProperties.every((value) => value === false)) {
            merged.additionalProperties = false;
        } else if (additionalProperties.some((value) => value === true)) {
            merged.additionalProperties = true;
        }
        return merged;
    }

    const nonNullBranches = branches.filter(
        (branch) => !(isSchemaObject(branch) && branch.type === 'null')
    );
    if (nonNullBranches.length === 1) {
        const merged = isSchemaObject(nonNullBranches[0])
            ? { ...base, ...nonNullBranches[0] }
            : base;
        if (nonNullBranches.length < branches.length) merged.nullable = true;
        return merged;
    }

    const types = branches.map((branch) =>
        isSchemaObject(branch) ? branch.type : undefined
    );
    if (types.length > 0 && types.every((type) => type === types[0])) {
        const merged: SchemaObject = {
            ...base,
            ...(isSchemaObject(branches[0]) ? branches[0] : {}),
            type: types[0],
        };
        const enumValues = branches.flatMap((branch) =>
            isSchemaObject(branch) && Array.isArray(branch.enum)
                ? branch.enum
                : []
        );
        if (enumValues.length > 0) {
            merged.enum = [...new Set(enumValues)];
        }
        return merged;
    }

    // ponytail: heterogeneous unions use the first branch; add an explicit
    // provider schema when a tool needs to preserve multiple primitive types.
    return {
        ...base,
        ...(isSchemaObject(branches[0]) ? branches[0] : {}),
    };
}
