import type { EvidenceError, Result } from "../shared/types.js";
import { err, ok } from "../shared/types.js";
import type { EvidenceFormat, EvidenceParseOptions, ParsedEvidence } from "./models.js";
import type { ByteCount, SafeProjectPath } from "../shared/types.js";

const jsonNames = new Set([
  "package.json", "package-lock.json", "composer.json", "composer.lock", "tsconfig.json", "jsconfig.json",
  "jsconfig.json", ".eslintrc.json", ".prettierrc.json", "vitest.config.json", "jest.config.json",
]);
const tomlNames = new Set(["pyproject.toml", "poetry.lock", "uv.lock", "config.toml"]);
const yamlNames = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "docker-compose.yml", "docker-compose.yaml"]);
const lockNames = new Set(["yarn.lock", "gemfile", "gemfile.lock", "requirements.txt", "poetry.lock", "uv.lock"]);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb", ".php", ".prisma"]);

export const formatForPath = (path: string): EvidenceFormat | undefined => {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? `.${name.split(".").pop() ?? ""}` : "";
  if (sourceExtensions.has(extension)) return "source-extension";
  if (tomlNames.has(name)) return "toml";
  if (name === ".prettierrc") return "json";
  if (yamlNames.has(name) || extension === ".yml" || extension === ".yaml") return "yaml";
  if (lockNames.has(name) || name.endsWith(".lock")) return "lockfile";
  if (jsonNames.has(name) || extension === ".json") return "json";
  return undefined;
};

export const isRecognizedEvidencePath = (path: string): boolean => formatForPath(path) !== undefined;

export const parseRecognizedEvidence = (
  path: SafeProjectPath,
  source: Uint8Array,
  options: EvidenceParseOptions = {},
): Result<ParsedEvidence, EvidenceError> => {
  const format = options.format ?? formatForPath(path);
  if (format === undefined) return invalid(path, "1:1", "El formato no está reconocido");
  const maxBytes = options.maxBytes as number | undefined;
  if (maxBytes !== undefined && source.byteLength > maxBytes) return invalid(path, "1:1", "El archivo supera el límite permitido");
  if (format === "source-extension") {
    return ok({ path, format, source: source.slice(), location: "1:1", validSyntax: true, validSchema: true });
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(source);
  const syntax = validateSyntax(text, format);
  if (!syntax.ok) return invalid(path, syntax.error.location, syntax.error.message);
  const schema = validateSchema(text, path, format);
  if (!schema.ok) return invalid(path, schema.error.location, schema.error.message, "INVALID_SCHEMA");
  return ok({ path, format, source: source.slice(), location: "1:1", validSyntax: true, validSchema: true });
};

interface ParseFailure { readonly location: string; readonly message: string; }
const invalid = (path: SafeProjectPath, location: string, cause: string, code: EvidenceError["code"] = "INVALID_SYNTAX"): Result<never, EvidenceError> => err({
  code, message: "Configuración inválida", cause, path, location, recoverability: "none",
});

const validateSyntax = (text: string, format: EvidenceFormat): Result<void, ParseFailure> => {
  if (format === "json") {
    try { JSON.parse(text) as unknown; return ok(undefined); }
    catch (error) { return parseJsonFailure(error, text); }
  }
  if (format === "toml") return validateToml(text);
  if (format === "yaml" || format === "lockfile") return validateYamlLike(text);
  return ok(undefined);
};

const parseJsonFailure = (error: unknown, text: string): Result<void, ParseFailure> => {
  const message = error instanceof Error ? error.message : "JSON inválido";
  const match = /position (\d+)/i.exec(message);
  const index = match?.[1] === undefined ? 0 : Number(match[1]);
  return err({ location: locationAt(text, index), message });
};

const validateSchema = (text: string, path: string, format: EvidenceFormat): Result<void, ParseFailure> => {
  if (format !== "json") return ok(undefined);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return err({ location: "1:1", message: "JSON inválido" }); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ location: "1:1", message: "Se esperaba un objeto" });
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "package.json") {
    const record = value as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts", "engines"]) {
      if (record[field] !== undefined && !isRecord(record[field])) return err({ location: "1:1", message: `El campo ${field} debe ser un objeto` });
    }
    if (record.name !== undefined && typeof record.name !== "string") return err({ location: "1:1", message: "El campo name debe ser texto" });
    if (record.type !== undefined && typeof record.type !== "string") return err({ location: "1:1", message: "El campo type debe ser texto" });
  }
  return ok(undefined);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const validateToml = (text: string): Result<void, ParseFailure> => {
  let section = "";
  for (const [lineIndex, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.replace(/\s+#.*$/u, "").trim();
    if (line === "") continue;
    if (line.startsWith("[") || line.startsWith("[[")) {
      const closing = line.startsWith("[[") ? "]]" : "]";
      if (!line.endsWith(closing) || line.length <= closing.length) return err({ location: `${lineIndex + 1}:1`, message: "Sección TOML inválida" });
      section = line;
      void section;
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0 || line.slice(separator + 1).trim() === "") return err({ location: `${lineIndex + 1}:1`, message: "Asignación TOML inválida" });
    const value = line.slice(separator + 1).trim();
    if (!isTomlValue(value)) return err({ location: `${lineIndex + 1}:${separator + 2}`, message: "Valor TOML inválido" });
  }
  return ok(undefined);
};

const isTomlValue = (value: string): boolean => {
  if (/^(true|false)$/u.test(value) || /^[-+]?\d+(\.\d+)?$/u.test(value)) return true;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return true;
  if (value.startsWith("[") && value.endsWith("]")) return true;
  if (value.startsWith("{") && value.endsWith("}")) return true;
  return /^\d{4}-\d{2}-\d{2}/u.test(value);
};

const validateYamlLike = (text: string): Result<void, ParseFailure> => {
  let previousIndent = 0;
  for (const [lineIndex, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#") || line.trim() === "---") continue;
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0 || indent > previousIndent + 2) return err({ location: `${lineIndex + 1}:1`, message: "Indentación YAML inválida" });
    const content = line.trim();
    if (!content.startsWith("-") && !content.includes(":")) return err({ location: `${lineIndex + 1}:1`, message: "Entrada YAML inválida" });
    if (content.endsWith(":") || content.startsWith("- ") || content.includes(": ")) previousIndent = indent;
  }
  return ok(undefined);
};

const locationAt = (text: string, index: number): string => {
  const prefix = text.slice(0, Math.max(0, index));
  return `${prefix.split(/\r?\n/u).length}:${(prefix.match(/[^\n]*$/u)?.[0].length ?? 0) + 1}`;
};

export const byteCount = (value: number): ByteCount => Math.max(0, Math.floor(value)) as ByteCount;
