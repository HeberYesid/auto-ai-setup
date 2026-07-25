import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { CanonicalPath, FileDescriptor, PlanningError, ProjectRelativePath, Result, SafeProjectPath } from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import type { AtomicFileSystemPort } from "../transaction/engine.js";
import { NodePathPolicy } from "./path-policy.js";

const bytes = (value: Uint8Array): Uint8Array => value.slice();
const ioError = (message: string): Result<never> => err({ code: "UNEXPECTED_ERROR", message, recoverability: "retry" });

/** Rooted local filesystem adapter used by the transaction engine. */
export class NodeTransactionalFileSystem implements AtomicFileSystemPort {
  private readonly pathPolicy = new NodePathPolicy();

  public constructor(private readonly root: CanonicalPath) {}

  /**
   * Rechecks both lexical and real containment. The transaction engine invokes this for every
   * planned target before it persists a journal or acquires a mutation lock.
   */
  public async validateContained(path: SafeProjectPath): Promise<Result<void>> {
    const checked = await this.checkedAbsolute(path);
    return checked.ok ? ok(undefined) : checked;
  }

  public async exists(path: SafeProjectPath): Promise<boolean> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) return false;
    try {
      await access(target.value);
      return true;
    } catch {
      return false;
    }
  }

  public async read(path: SafeProjectPath): Promise<Uint8Array> {
    const target = await this.absoluteOrThrow(path);
    return readFile(target);
  }

  public async write(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) return target;
    try {
      await mkdir(dirname(target.value), { recursive: true });
      await writeFile(target.value, bytes(content));
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to write ${path}: ${safeCause(cause)}`);
    }
  }

  public async createExclusive(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) return target;
    try {
      await mkdir(dirname(target.value), { recursive: true });
      await writeFile(target.value, bytes(content), { flag: "wx", mode: 0o600 });
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to acquire exclusive lock ${path}: ${safeCause(cause)}`);
    }
  }

  public async writeAtomic(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) throw securityException(target.error);
    const temporary = `${target.value}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target.value), { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes(content));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target.value);
      return ok(undefined);
    } catch (cause) {
      try {
        await unlink(temporary);
      } catch {
        /* preserve the original failure */
      }
      return ioError(`Unable to atomically write ${path}: ${safeCause(cause)}`);
    }
  }

  public async fsync(path: SafeProjectPath): Promise<Result<void>> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) return target;
    try {
      const handle = await open(target.value, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to fsync ${path}: ${safeCause(cause)}`);
    }
  }

  public async remove(path: SafeProjectPath): Promise<Result<void>> {
    const target = await this.checkedAbsolute(path);
    if (!target.ok) return target;
    try {
      await rm(target.value, { force: true });
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to remove ${path}: ${safeCause(cause)}`);
    }
  }

  public async *list(root: CanonicalPath): AsyncIterable<FileDescriptor> {
    void root;
    yield* this.walk(this.root, this.root);
  }

  private async *walk(base: string, current: string): AsyncIterable<FileDescriptor> {
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const absolute = join(current, child.name);
      if (child.isDirectory()) {
        yield* this.walk(base, absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const relativePath = relative(base, absolute).split(sep).join("/");
      const safe = asSafeProjectPath(relativePath);
      if (!safe.ok) continue;
      const metadata = await stat(absolute);
      yield {
        path: safe.value,
        extension: child.name.includes(".") ? `.${child.name.split(".").pop() ?? ""}` : "",
        bytes: metadata.size as never,
        isSymlink: false,
      };
    }
  }

  private async checkedAbsolute(path: SafeProjectPath): Promise<Result<string, PlanningError>> {
    const checked = await this.pathPolicy.resolveDestination(this.root, String(path) as ProjectRelativePath);
    return checked.ok ? ok(resolve(this.root, String(checked.value))) : checked;
  }

  private async absoluteOrThrow(path: SafeProjectPath): Promise<string> {
    const checked = await this.checkedAbsolute(path);
    if (checked.ok) return checked.value;
    throw securityException(checked.error);
  }
}

const securityException = (error: PlanningError): Error => {
  const exception = new Error(`Path escapes transaction root: ${error.message}`);
  const details: Record<string, unknown> = { ...error };
  delete details.message;
  Object.assign(exception, details);
  return exception;
};

const safeCause = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/g, " ").slice(0, 240);

export const createNodeTransactionalFileSystem = (root: CanonicalPath): NodeTransactionalFileSystem =>
  new NodeTransactionalFileSystem(root);
