import type { Redactor } from "../shared/ports.js";

export const REDACTED = "[REDACTED]" as const;

const SENSITIVE_KEY = /(?:secret|token|password|passwd|credential|private[\s_-]*key|api[\s_-]*key|access[\s_-]*key|authorization|cookie|session|refresh[\s_-]*token|client[\s_-]*secret)/i;
const OMIT_KEY = /^(?:body|download(?:ed)?(?:body|content)?|response(?:Body|Content)?|raw(?:Body|Response)|env|environment|stdout)$/i;
const PEM = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi;
const AUTH_URL = /https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@[^\s]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const ASSIGNMENT = /\b(?:token|secret|password|passwd|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi;

const isSecretLike = (value: string): boolean => {
  const patterns = [PEM, AUTH_URL, BEARER, JWT, ASSIGNMENT];
  return patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(value); });
};

const redactString = (value: string, knownSecrets: readonly string[]): string => {
  let result = value;
  for (const secret of knownSecrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED);
  }
  result = result.replace(PEM, REDACTED).replace(AUTH_URL, REDACTED).replace(BEARER, REDACTED).replace(JWT, REDACTED).replace(ASSIGNMENT, REDACTED);
  return result;
};

const redactValue = (value: unknown, knownSecrets: readonly string[], key: string, seen: WeakSet<object>): unknown => {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return isSecretLike(value) || knownSecrets.some((secret) => secret.length > 0 && value.includes(secret)) ? redactString(value, knownSecrets) : value;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactValue(entry, knownSecrets, "", seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (OMIT_KEY.test(childKey)) continue;
    result[childKey] = redactValue(childValue, knownSecrets, childKey, seen);
  }
  seen.delete(value);
  return result;
};

export class SecretRedactor implements Redactor {
  public redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
    return redactValue(value, knownSecrets, "", new WeakSet<object>());
  }
}

export const redactSecrets = (value: unknown, knownSecrets: readonly string[] = []): unknown => new SecretRedactor().redact(value, knownSecrets);
export const RecursiveSecretRedactor = SecretRedactor;
