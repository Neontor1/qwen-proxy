/**
 * Minimal JSON Schema validator (subset of draft-07) used to validate tool-call
 * arguments before they are forwarded to the client. Intentionally dependency
 * free — the full schema surface is not needed for proxying.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function walk(value: unknown, schema: any, path: string, issues: ValidationIssue[]): void {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.some((t) => {
      if (t === 'integer') return actual === 'number' && Number.isInteger(value as number);
      if (t === 'number') return actual === 'number';
      return t === actual;
    });
    if (!ok) {
      issues.push({ path, message: `expected ${types.join('|')}, got ${actual}` });
      return;
    }
  }

  if (
    schema.enum &&
    Array.isArray(schema.enum) &&
    !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    issues.push({ path, message: `value not in enum [${schema.enum.join(', ')}]` });
  }

  const actual = typeOf(value);
  if (actual === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const [key, sub] of Object.entries(schema.properties as Record<string, any>)) {
      if (key in obj) walk(obj[key], sub, path ? `${path}.${key}` : key, issues);
    }
    for (const req of schema.required ?? []) {
      if (!(req in obj))
        issues.push({ path: path ? `${path}.${req}` : req, message: 'required property missing' });
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties as Record<string, unknown>))) {
          issues.push({ path: path ? `${path}.${key}` : key, message: 'additional property not allowed' });
        }
      }
    }
  }

  if (actual === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) {
      issues.push({ path, message: `needs at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) {
      issues.push({ path, message: `needs at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      arr.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, issues));
    }
  }

  if (actual === 'string' && typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern).test(value as string)) {
        issues.push({ path, message: `does not match pattern ${schema.pattern}` });
      }
    } catch {
      /* invalid pattern in schema — ignore */
    }
  }
}

export function validateAgainstSchema(value: unknown, schema: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  walk(value, schema, '', issues);
  return { valid: issues.length === 0, issues };
}
