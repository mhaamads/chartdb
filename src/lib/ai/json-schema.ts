/**
 * Bridges Zod schemas to the JSON Schema dialect that LLM providers accept.
 *
 * All three providers (OpenAI, Anthropic, Gemini) accept a *subset* of
 * JSON Schema 7. The common subset we target is:
 *   - `type`, `properties`, `required`, `enum`, `items`, `additionalProperties`
 *   - `description`, no `$ref` (providers reject deep refs)
 *
 * Emit JSON Schema 7 (including real null types); provider adapters handle
 * their own dialect restrictions.
 */

import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AIToolJSONSchema } from './types';

export function zodToToolSchema(schema: ZodTypeAny): AIToolJSONSchema {
    const raw = zodToJsonSchema(schema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
    }) as Record<string, unknown>;
    // Strip any draft pointers that some providers reject.
    delete raw.$schema;
    delete raw.definitions;
    return raw as AIToolJSONSchema;
}

/**
 * Conservative compatibility schema for the existing DeepSeek integration.
 * Merge object unions into a permissive non-strict shape; Zod still validates
 * the exact operation. This is not DeepSeek beta strict-mode conversion.
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

    const normalized = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
            key,
            // Property names are data: a column attribute named "nullable" is
            // not the OpenAPI nullable keyword and must survive conversion.
            key === 'properties' && isSchemaObject(child)
                ? Object.fromEntries(
                      Object.entries(child).map(([name, schema]) => [
                          name,
                          sanitizeSchema(schema),
                      ])
                  )
                : sanitizeSchema(child),
        ])
    );
    const unionKey = Array.isArray(normalized.anyOf)
        ? 'anyOf'
        : Array.isArray(normalized.oneOf)
          ? 'oneOf'
          : undefined;
    if (!unionKey) return normalizeDeepSeekSchema(normalized);
    const branches = normalized[unionKey] as unknown[];
    delete normalized.anyOf;
    delete normalized.oneOf;
    return normalizeDeepSeekSchema(mergeSchemaBranches(normalized, branches));
}

function normalizeDeepSeekSchema(schema: SchemaObject): SchemaObject {
    const normalized = { ...schema };

    // ponytail: keep the provider schema to DeepSeek's supported subset;
    // Zod remains the runtime validator for constraints removed here.
    for (const key of [
        'nullable',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
    ]) {
        delete normalized[key];
    }

    for (const [exclusiveKey, limitKey] of [
        ['exclusiveMinimum', 'minimum'],
        ['exclusiveMaximum', 'maximum'],
    ] as const) {
        if (normalized[exclusiveKey] === true) {
            const limit = normalized[limitKey];
            if (typeof limit === 'number') {
                normalized[exclusiveKey] = limit;
                delete normalized[limitKey];
            } else {
                delete normalized[exclusiveKey];
            }
        } else if (normalized[exclusiveKey] === false) {
            delete normalized[exclusiveKey];
        }
    }

    if (normalized.type === 'object') {
        const properties = isSchemaObject(normalized.properties)
            ? normalized.properties
            : {};
        normalized.properties = properties;
        // This adapter uses non-strict mode. Making optional update fields
        // required makes the model invent unwanted changes.
        if (Array.isArray(normalized.required)) {
            normalized.required = normalized.required.filter(
                (key) => typeof key === 'string' && key in properties
            );
        }
        normalized.additionalProperties = false;
    }

    return normalized;
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
        return normalizeDeepSeekSchema(merged);
    }

    const nonNullBranches = branches.filter(
        (branch) => !(isSchemaObject(branch) && branch.type === 'null')
    );
    if (nonNullBranches.length === 1) {
        const merged = isSchemaObject(nonNullBranches[0])
            ? { ...base, ...nonNullBranches[0] }
            : base;
        if (nonNullBranches.length < branches.length) merged.nullable = true;
        return normalizeDeepSeekSchema(merged);
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
        return normalizeDeepSeekSchema(merged);
    }

    // ponytail: heterogeneous unions use the first branch; add an explicit
    // provider schema when a tool needs to preserve multiple primitive types.
    return normalizeDeepSeekSchema({
        ...base,
        ...(isSchemaObject(branches[0]) ? branches[0] : {}),
    });
}
