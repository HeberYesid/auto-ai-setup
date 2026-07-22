import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { CanonicalPath, FileDescriptor, Result, SafeProjectPath } from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import type { AtomicFileSystemPort } from "../transaction/engine.js";

const bytes = (value: Uint8Array): Uint8Array => value.slice();
const ioError = (message: string): Result<never> => err({ code: "UNEXPECTED_ERROR", message, recoverability: "retry" });

/** Rooted local filesystem adapter used by the transaction engine. */
export class NodeTransactionalFileSystem implements AtomicFileSystemPort {
  public constructor(private readonly root: CanonicalPath) {}

  public async exists(path: SafeProjectPath): Promise<boolean> {
    try {
      await access(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }
  public async read(path: SafeProjectPath): Promise<Uint8Array> {
    return readFile(this.absolute(path));
  }
  public async write(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    try {
      await mkdir(dirname(this.absolute(path)), { recursive: true });
      await writeFile(this.absolute(path), bytes(content));
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to write ${path}: ${safeCause(cause)}`);
    }
  }
  public async createExclusive(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    try {
      await mkdir(dirname(this.absolute(path)), { recursive: true });
      await writeFile(this.absolute(path), bytes(content), { flag: "wx", mode: 0o600 });
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to acquire exclusive lock ${path}: ${safeCause(cause)}`);
    }
  }
  public async writeAtomic(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    const target = this.absolute(path);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes(content));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
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
    try {
      const handle = await open(this.absolute(path), "r");
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
    try {
      await rm(this.absolute(path), { force: true });
      return ok(undefined);
    } catch (cause) {
      return ioError(`Unable to remove ${path}: ${safeCause(cause)}`);
    }
  }
  public async *list(root: CanonicalPath): AsyncIterable<FileDescriptor> {
    const base = root === this.root ? this.root : this.root;
    yield* this.walk(base, base);
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
  private absolute(path: SafeProjectPath): string {
    const value = String(path);
    const target = resolve(this.root, value);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error("Path escapes transaction root");
    return target;
  }
}

const safeCause = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/g, " ").slice(0, 240);
export const createNodeTransactionalFileSystem = (root: CanonicalPath): NodeTransactionalFileSystem =>
  new NodeTransactionalFileSystem(root);
