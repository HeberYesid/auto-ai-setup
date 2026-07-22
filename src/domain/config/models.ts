import type { ConfigError, Result, SafeProjectPath } from "../shared/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface SourceDocument {
  readonly path: SafeProjectPath;
  readonly text: string;
  readonly format: "json";
}

export interface DocumentStyle {
  readonly indentation: string;
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
}

export interface ParsedConfig<T extends JsonObject> {
  readonly model: T;
  readonly style: DocumentStyle;
}

export interface ManagedPatch {
  readonly paths: Readonly<Record<string, JsonValue>>;
}

export type { ConfigError };

export interface StructuredConfigCodec<T extends JsonObject> {
  parse(source: SourceDocument): Result<ParsedConfig<T>, ConfigError>;
  validate(model: T): Result<T, ConfigError>;
  merge(model: T, patch: ManagedPatch): Result<T, ConfigError>;
  serialize(model: T, style: DocumentStyle): Result<string, ConfigError>;
  equivalent(a: T, b: T): boolean;
}

export interface ConfigFieldChange {
  readonly path: string;
  readonly action: "add" | "remove" | "change";
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

export interface ConfigFieldDiff {
  readonly kind: "fields";
  readonly changes: readonly ConfigFieldChange[];
}

export type JsonConfigSchema<T extends JsonObject> = (model: T) => boolean | string | Result<T, ConfigError>;

export interface JsonStructuredConfigCodecOptions<T extends JsonObject> {
  /** Optional document-specific schema check. Unknown fields should be accepted by the check. */
  readonly schema?: JsonConfigSchema<T>;
}
