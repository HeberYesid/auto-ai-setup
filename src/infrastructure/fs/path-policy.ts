import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathPolicy } from "../../domain/index.js";
import { err, ok } from "../../domain/index.js";
import type { CanonicalPath, PlanningError, ProjectRelativePath, Result, SafeProjectPath } from "../../domain/index.js";

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_DRIVE = /^[a-z]:/i;

const unsafe = (path: string, message: string): Result<SafeProjectPath, PlanningError> => err({
  code: "UNSAFE_DESTINATION",
  message,
  recoverability: "none",
  path,
  exitCode: 2,
});

const normalizeRequested = (requested: string): Result<string, PlanningError> => {
  if (requested.length === 0 || requested.includes("\0") || requested.includes("\\")) return unsafe(requested, "Destination must use normalized project-relative separators");
  if (isAbsolute(requested) || requested.startsWith("/") || WINDOWS_DRIVE.test(requested)) return unsafe(requested, "Absolute and device paths are not allowed");
  const parts = requested.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return unsafe(requested, "Path traversal is not allowed");
    if (WINDOWS_DEVICE.test(part)) return unsafe(requested, "Device names are not valid destinations");
    normalized.push(part);
  }
  if (normalized.length === 0) return unsafe(requested, "Destination must name a project-relative path");
  return ok(normalized.join("/"));
};

const isContained = (root: string, candidate: string): boolean => {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const remainder = relative(rootResolved, candidateResolved);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
};

const pathError = (path: string, cause: unknown): Result<SafeProjectPath, PlanningError> => err({
  code: "UNSAFE_DESTINATION",
  message: "Unable to verify destination containment",
  cause: cause instanceof Error ? cause.message : String(cause),
  recoverability: "none",
  path,
  exitCode: 2,
});

/**
 * Filesystem-backed destination policy. It returns a normalized relative path,
 * but checks the corresponding absolute path and every existing ancestor before
 * returning it. Missing final destinations are therefore safe to plan.
 */
export class NodePathPolicy implements PathPolicy {
  public async resolveDestination(root: CanonicalPath, requested: ProjectRelativePath): Promise<Result<SafeProjectPath, PlanningError>> {
    const normalized = normalizeRequested(requested);
    if (!normalized.ok) return normalized;
    const rootPath = resolve(root);
    const candidate = resolve(rootPath, normalized.value);
    if (!isContained(rootPath, candidate)) return unsafe(requested, "Destination is outside the project root");

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
    } catch (cause: unknown) {
      return pathError(root, cause);
    }
    if (!isContained(canonicalRoot, rootPath)) return unsafe(requested, "Project root is not canonical");

    const segments = normalized.value.split("/");
    let current = canonicalRoot;
    for (const segment of segments) {
      current = join(current, segment);
      let entry;
      try {
        entry = await lstat(current);
      } catch (cause: unknown) {
        if (isMissing(cause)) break;
        return pathError(current, cause);
      }
      if (entry.isSymbolicLink()) {
        let linked: string;
        try {
          linked = await realpath(current);
        } catch (cause: unknown) {
          return pathError(current, cause);
        }
        if (!isContained(canonicalRoot, linked)) return unsafe(requested, "Destination ancestor escapes the project root through a symlink");
        if (current === candidate) return unsafe(requested, "A destination symlink cannot be replaced safely");
        current = linked;
      }
    }

    try {
      const targetStat = await lstat(candidate);
      if (targetStat.isSymbolicLink()) return unsafe(requested, "A destination symlink cannot be replaced safely");
      const targetReal = await realpath(candidate);
      if (!isContained(canonicalRoot, targetReal)) return unsafe(requested, "Destination resolves outside the project root");
    } catch (cause: unknown) {
      if (!isMissing(cause)) return pathError(candidate, cause);
      // A new destination is checked through its nearest existing ancestor above.
    }
    return ok(normalized.value as SafeProjectPath);
  }
}

const isMissing = (cause: unknown): boolean => typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === "ENOENT";

export const createPathPolicy = (): PathPolicy => new NodePathPolicy();
export const FileSystemPathPolicy = NodePathPolicy;
