import { err, ok } from "../shared/types.js";
import type { ConfigError, Result } from "../shared/types.js";
import type {
  ConfigFieldChange,
  ConfigFieldDiff,
  DocumentStyle,
  JsonConfigSchema,
  JsonObject,
  JsonValue,
  ManagedPatch,
  ParsedConfig,
  SourceDocument,
  StructuredConfigCodec,
} from "./models.js";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const HEX_DIGITS = /^[0-9a-fA-F]$/;

type MutableJsonObject = { [key: string]: JsonValue };
type MutableJsonArray = JsonValue[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonObject = (value: unknown): value is JsonObject => isObject(value);

const pointerSegment = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
const pointerFor = (parent: string, segment: string): string => `${parent}/${pointerSegment(segment)}`;

const locationAt = (text: string, index: number): { readonly line: number; readonly column: number } => {
  let line = 1;
  let column = 1;
  const bounded = Math.max(0, Math.min(index, text.length));
  for (let offset = 0; offset < bounded; offset += 1) {
    if (text.charAt(offset) === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
};

const configError = (
  code: ConfigError["code"],
  message: string,
  path: string,
  text: string,
  index = 0,
  cause?: string,
): ConfigError => {
  const { line, column } = locationAt(text, index);
  const result: ConfigError = {
    code,
    message,
    path,
    location: `${line}:${column}`,
    line,
    column,
    recoverability: "none",
  };
  if (cause !== undefined) return { ...result, cause };
  return result;
};

const configRuntimeError = (
  code: ConfigError["code"],
  message: string,
  path: string,
  cause?: string,
): ConfigError => configError(code, message, path, "", 0, cause);

const cloneJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (isObject(value)) {
    const result: MutableJsonObject = {};
    for (const key of Object.keys(value)) result[key] = cloneJson(value[key] as JsonValue);
    return result;
  }
  return value;
};

const isDangerousKey = (key: string): boolean => DANGEROUS_KEYS.has(key);

class JsonParser {
  private index = 0;

  public constructor(private readonly text: string) {}

  public parse(): Result<JsonValue, ConfigError> {
    this.skipWhitespace();
    const value = this.readValue("");
    if (!value.ok) return value;
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      return err(configError("CONFIG_SYNTAX", "Unexpected content after the JSON document", "", this.text, this.index));
    }
    return value;
  }

  private readValue(path: string): Result<JsonValue, ConfigError> {
    this.skipWhitespace();
    const character = this.text.charAt(this.index);
    if (character === "{") return this.readObject(path);
    if (character === "[") return this.readArray(path);
    if (character === '"') return this.readString();
    if (character === "t" && this.consumeLiteral("true")) return ok(true);
    if (character === "f" && this.consumeLiteral("false")) return ok(false);
    if (character === "n" && this.consumeLiteral("null")) return ok(null);
    if (character === "-" || /\d/.test(character)) return this.readNumber(path);
    return err(configError("CONFIG_SYNTAX", "Expected a JSON value", path, this.text, this.index));
  }

  private readObject(path: string): Result<JsonValue, ConfigError> {
    this.index += 1;
    const result: MutableJsonObject = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "}") {
      this.index += 1;
      return ok(result);
    }

    while (this.index < this.text.length) {
      this.skipWhitespace();
      const keyLocation = this.index;
      const keyResult = this.readString();
      if (!keyResult.ok) return keyResult;
      const key = keyResult.value;
      const keyPath = pointerFor(path, key);
      if (isDangerousKey(key)) {
        return err(configError("DANGEROUS_KEY", `Dangerous object key is not allowed: ${key}`, keyPath, this.text, keyLocation));
      }
      if (keys.has(key)) {
        return err(configError("DUPLICATE_KEY", `Duplicate object key: ${key}`, keyPath, this.text, keyLocation));
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== ":") {
        return err(configError("CONFIG_SYNTAX", "Expected ':' after an object key", keyPath, this.text, this.index));
      }
      this.index += 1;
      const value = this.readValue(keyPath);
      if (!value.ok) return value;
      result[key] = value.value;
      this.skipWhitespace();
      const delimiter = this.text.charAt(this.index);
      if (delimiter === "}") {
        this.index += 1;
        return ok(result);
      }
      if (delimiter !== ",") {
        return err(configError("CONFIG_SYNTAX", "Expected ',' or '}' in an object", path, this.text, this.index));
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text.charAt(this.index) === "}") {
        return err(configError("CONFIG_SYNTAX", "Trailing commas are not valid JSON", path, this.text, this.index));
      }
    }
    return err(configError("CONFIG_SYNTAX", "Unterminated JSON object", path, this.text, this.index));
  }

  private readArray(path: string): Result<JsonValue, ConfigError> {
    this.index += 1;
    const result: MutableJsonArray = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "]") {
      this.index += 1;
      return ok(result);
    }

    while (this.index < this.text.length) {
      const itemPath = pointerFor(path, String(result.length));
      const value = this.readValue(itemPath);
      if (!value.ok) return value;
      result.push(value.value);
      this.skipWhitespace();
      const delimiter = this.text.charAt(this.index);
      if (delimiter === "]") {
        this.index += 1;
        return ok(result);
      }
      if (delimiter !== ",") {
        return err(configError("CONFIG_SYNTAX", "Expected ',' or ']' in an array", path, this.text, this.index));
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text.charAt(this.index) === "]") {
        return err(configError("CONFIG_SYNTAX", "Trailing commas are not valid JSON", path, this.text, this.index));
      }
    }
    return err(configError("CONFIG_SYNTAX", "Unterminated JSON array", path, this.text, this.index));
  }

  private readString(): Result<string, ConfigError> {
    const start = this.index;
    if (this.text.charAt(this.index) !== '"') {
      return err(configError("CONFIG_SYNTAX", "Expected a JSON string", "", this.text, this.index));
    }
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text.charAt(this.index);
      if (character === '"') {
        this.index += 1;
        try {
          const parsed: unknown = JSON.parse(this.text.slice(start, this.index));
          return typeof parsed === "string"
            ? ok(parsed)
            : err(configError("CONFIG_SYNTAX", "Invalid JSON string", "", this.text, start));
        } catch (cause: unknown) {
          return err(configError("CONFIG_SYNTAX", "Invalid JSON string escape", "", this.text, start, cause instanceof Error ? cause.message : String(cause)));
        }
      }
      if (character < " ") {
        return err(configError("CONFIG_SYNTAX", "Unescaped control character in JSON string", "", this.text, this.index));
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.text.charAt(this.index);
        if (escape === "u") {
          for (let digit = 0; digit < 4; digit += 1) {
            this.index += 1;
            if (!HEX_DIGITS.test(this.text.charAt(this.index))) {
              return err(configError("CONFIG_SYNTAX", "Invalid unicode escape in JSON string", "", this.text, this.index));
            }
          }
        } else if (!'"\\/bfnrt'.includes(escape)) {
          return err(configError("CONFIG_SYNTAX", "Invalid escape in JSON string", "", this.text, this.index));
        }
      }
      this.index += 1;
    }
    return err(configError("CONFIG_SYNTAX", "Unterminated JSON string", "", this.text, start));
  }

  private readNumber(path: string): Result<JsonValue, ConfigError> {
    const match = this.text.slice(this.index).match(NUMBER_PATTERN);
    if (match === null) return err(configError("CONFIG_SYNTAX", "Invalid JSON number", path, this.text, this.index));
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      return err(configError("UNREPRESENTABLE_VALUE", "JSON number cannot be represented safely", path, this.text, this.index - match[0].length));
    }
    return ok(value);
  }

  private consumeLiteral(literal: string): boolean {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) return false;
    this.index += literal.length;
    return true;
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.text.charAt(this.index))) this.index += 1;
  }
}

const validateJsonValue = (
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet<object>(),
): ConfigError | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : configRuntimeError("UNREPRESENTABLE_VALUE", "JSON numbers must be finite", path);
  }
  if (typeof value !== "object") {
    return configRuntimeError("UNREPRESENTABLE_VALUE", "Value is not representable as JSON", path);
  }
  if (seen.has(value)) return configRuntimeError("UNREPRESENTABLE_VALUE", "Cyclic values are not representable as JSON", path);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const childError = validateJsonValue(value[index], pointerFor(path, String(index)), seen);
      if (childError !== undefined) return childError;
    }
    seen.delete(value);
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const childPath = pointerFor(path, key);
    if (isDangerousKey(key)) return configRuntimeError("DANGEROUS_KEY", `Dangerous object key is not allowed: ${key}`, childPath);
    const childError = validateJsonValue(object[key], childPath, seen);
    if (childError !== undefined) return childError;
  }
  seen.delete(value);
  return undefined;
};

const schemaError = <T extends JsonObject>(
  result: boolean | string | Result<T, ConfigError>,
): ConfigError | undefined => {
  if (result === true) return undefined;
  if (result === false) return configRuntimeError("CONFIG_SCHEMA", "Configuration does not satisfy its schema", "");
  if (typeof result === "string") return configRuntimeError("CONFIG_SCHEMA", result, "");
  if (!result.ok) return result.error;
  return undefined;
};

const decodePointer = (pointer: string): Result<readonly string[], ConfigError> => {
  if (pointer === "") return ok([]);
  if (!pointer.startsWith("/")) {
    return err(configRuntimeError("CONFIG_SCHEMA", "Managed patch paths must be JSON Pointers", pointer));
  }
  const segments = pointer.slice(1).split("/").map((segment) => {
    let decoded = "";
    for (let index = 0; index < segment.length; index += 1) {
      const character = segment.charAt(index);
      if (character !== "~") {
        decoded += character;
      } else {
        const escape = segment.charAt(index + 1);
        if (escape !== "0" && escape !== "1") return undefined;
        decoded += escape === "0" ? "~" : "/";
        index += 1;
      }
    }
    return decoded;
  });
  if (segments.some((segment) => segment === undefined)) {
    return err(configRuntimeError("CONFIG_SCHEMA", "Managed patch contains an invalid JSON Pointer escape", pointer));
  }
  const values = segments as readonly string[];
  for (const segment of values) {
    if (isDangerousKey(segment)) {
      return err(configRuntimeError("DANGEROUS_KEY", `Dangerous object key is not allowed: ${segment}`, pointer));
    }
  }
  return ok(values);
};

const setAtPointer = (
  root: JsonObject,
  segments: readonly string[],
  value: JsonValue,
  pointer: string,
): Result<JsonObject, ConfigError> => {
  if (segments.length === 0) {
    if (!isJsonObject(value)) return err(configRuntimeError("CONFIG_SCHEMA", "The root configuration must be an object", pointer));
    return ok(cloneJson(value) as JsonObject);
  }

  let current: JsonValue = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const isLast = index === segments.length - 1;
    if (Array.isArray(current)) {
      const array = current as MutableJsonArray;
      if (segment === "-") {
        if (!isLast) return err(configRuntimeError("CONFIG_SCHEMA", "Array append must be the final JSON Pointer segment", pointer));
        array.push(cloneJson(value));
        return ok(root);
      }
      if (!/^0|[1-9]\d*$/.test(segment)) return err(configRuntimeError("CONFIG_SCHEMA", "Array JSON Pointer segment must be an index", pointer));
      const arrayIndex = Number(segment);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= array.length) {
        return err(configRuntimeError("CONFIG_SCHEMA", "Array JSON Pointer index does not exist", pointer));
      }
      if (isLast) {
        array[arrayIndex] = cloneJson(value);
        return ok(root);
      }
      current = array[arrayIndex] as JsonValue;
      continue;
    }
    if (!isJsonObject(current)) return err(configRuntimeError("CONFIG_SCHEMA", "A managed patch traverses a non-object value", pointer));
    const object = current as MutableJsonObject;
    if (isLast) {
      object[segment] = cloneJson(value);
      return ok(root);
    }
    if (!(segment in object)) object[segment] = {};
    current = object[segment] as JsonValue;
  }
  return ok(root);
};

const detectStyle = (text: string): DocumentStyle => {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n") || text.endsWith("\r");
  let indentation = "";
  for (const line of text.split(/\r\n|\n/)) {
    const match = line.match(/^([ \t]+)\S/);
    if (match !== null) {
      indentation = match[1] as string;
      break;
    }
  }
  return { indentation, eol, finalNewline };
};

const renderJson = (value: JsonValue, indentation: string, eol: "\n" | "\r\n", level: number): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) as string;
  }
  const pad = indentation.repeat(level);
  const childPad = indentation.repeat(level + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const entries = value.map((entry) => `${childPad}${renderJson(entry, indentation, eol, level + 1)}`);
    return indentation.length === 0 ? `[${entries.map((entry) => entry.trimStart()).join(",")}]` : `[${eol}${entries.join(`,${eol}`)}${eol}${pad}]`;
  }
  const object = value as JsonObject;
  const entries = Object.keys(object).map((key) => {
    const renderedKey = JSON.stringify(key) as string;
    return `${childPad}${renderedKey}:${indentation.length === 0 ? "" : " "}${renderJson(object[key] as JsonValue, indentation, eol, level + 1)}`;
  });
  return indentation.length === 0 ? `{${entries.map((entry) => entry.trimStart()).join(",")}}` : `{${eol}${entries.join(`,${eol}`)}${eol}${pad}}`;
};

const diffValue = (before: JsonValue | undefined, after: JsonValue | undefined, path: string): ConfigFieldChange[] => {
  if (before === undefined) {
    return [{ path, action: "add", after: cloneJson(after as JsonValue) }];
  }
  if (after === undefined) {
    return [{ path, action: "remove", before: cloneJson(before) }];
  }
  if (deepEquivalent(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: ConfigFieldChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = pointerFor(path, String(index));
      changes.push(...diffValue(before[index], after[index], childPath));
    }
    return changes;
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    const changes: ConfigFieldChange[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      changes.push(...diffValue(hasBefore ? before[key] : undefined, hasAfter ? after[key] : undefined, pointerFor(path, key)));
    }
    return changes;
  }
  return [{ path, action: "change", before: cloneJson(before), after: cloneJson(after) }];
};

const deepEquivalent = (a: JsonValue, b: JsonValue): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEquivalent(value, b[index] as JsonValue));
  }
  if (isJsonObject(a) || isJsonObject(b)) {
    if (!isJsonObject(a) || !isJsonObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && deepEquivalent(a[key] as JsonValue, b[key] as JsonValue));
  }
  return false;
};

export class JsonStructuredConfigCodec<T extends JsonObject = JsonObject> implements StructuredConfigCodec<T> {
  private readonly schema: JsonConfigSchema<T> | undefined;

  public constructor(options: { readonly schema?: JsonConfigSchema<T> } = {}) {
    this.schema = options.schema;
  }

  public parse(source: SourceDocument): Result<ParsedConfig<T>, ConfigError> {
    if (typeof source.text !== "string") {
      return err(configError("CONFIG_SYNTAX", "Configuration source must be text", "", "", 0));
    }
    const parsed = new JsonParser(source.text).parse();
    if (!parsed.ok) return parsed;
    if (!isJsonObject(parsed.value)) {
      return err(configError("CONFIG_SCHEMA", "The root configuration must be a JSON object", "", source.text, 0));
    }
    const validated = this.validate(parsed.value as T);
    if (!validated.ok) return validated;
    return ok({ model: validated.value, style: detectStyle(source.text) });
  }

  public validate(model: T): Result<T, ConfigError> {
    if (!isJsonObject(model)) {
      return err(configRuntimeError("CONFIG_SCHEMA", "The root configuration must be a JSON object", ""));
    }
    const valueError = validateJsonValue(model, "");
    if (valueError !== undefined) return err(valueError);
    if (this.schema !== undefined) {
      const validation = schemaError(this.schema(model));
      if (validation !== undefined) return err(validation);
    }
    return ok(model);
  }

  public merge(model: T, patch: ManagedPatch): Result<T, ConfigError> {
    const validated = this.validate(model);
    if (!validated.ok) return validated;
    if (!isObject(patch.paths)) {
      return err(configRuntimeError("CONFIG_SCHEMA", "Managed patch paths must be an object", ""));
    }
    let merged = cloneJson(validated.value) as JsonObject;
    const paths = Object.keys(patch.paths).sort();
    for (const path of paths) {
      const pointer = decodePointer(path);
      if (!pointer.ok) return pointer;
      const value = patch.paths[path];
      if (value === undefined) return err(configRuntimeError("CONFIG_SCHEMA", "Managed patch values must be JSON values", path));
      const valueError = validateJsonValue(value, path);
      if (valueError !== undefined) return err(valueError);
      const updated = setAtPointer(merged, pointer.value, value, path);
      if (!updated.ok) return updated;
      merged = updated.value;
    }
    const result = this.validate(merged as T);
    return result;
  }

  public serialize(model: T, style: DocumentStyle): Result<string, ConfigError> {
    const validated = this.validate(model);
    if (!validated.ok) return validated;
    if (typeof style.indentation !== "string" || !/^[ \t]*$/.test(style.indentation)) {
      return err(configRuntimeError("CONFIG_SCHEMA", "Indentation must contain only spaces or tabs", ""));
    }
    if (style.eol !== "\n" && style.eol !== "\r\n") {
      return err(configRuntimeError("CONFIG_SCHEMA", "EOL must be LF or CRLF", ""));
    }
    if (typeof style.finalNewline !== "boolean") {
      return err(configRuntimeError("CONFIG_SCHEMA", "finalNewline must be boolean", ""));
    }
    let text = renderJson(validated.value, style.indentation, style.eol, 0);
    if (style.finalNewline) text += style.eol;
    return ok(text);
  }

  public equivalent(a: T, b: T): boolean {
    return isJsonObject(a) && isJsonObject(b) && deepEquivalent(a, b);
  }

  public diff(a: T, b: T): ConfigFieldDiff {
    return { kind: "fields", changes: diffValue(a, b, "") };
  }
}

export const createJsonStructuredConfigCodec = <T extends JsonObject = JsonObject>(
  options: { readonly schema?: JsonConfigSchema<T> } = {},
): JsonStructuredConfigCodec<T> => new JsonStructuredConfigCodec(options);

export const diffFields = (before: JsonValue, after: JsonValue): ConfigFieldDiff => ({
  kind: "fields",
  changes: diffValue(before, after, ""),
});

export const fieldDiff = diffFields;
export const computeFieldDiff = diffFields;
export const jsonStructuredConfigCodec = new JsonStructuredConfigCodec<JsonObject>();
export { JsonStructuredConfigCodec as JSONStructuredConfigCodec };
