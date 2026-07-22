import { asCanonicalPath, asSafeProjectPath } from "../../src/domain/index.js";
import type { CanonicalPath, SafeProjectPath } from "../../src/domain/index.js";
import { FakeFileSystem } from "./fakes.js";

export interface VirtualProjectFixture {
  readonly root: CanonicalPath;
  readonly fs: FakeFileSystem;
  readonly files: Readonly<Record<string, SafeProjectPath>>;
}

export const virtualProject = (files: Readonly<Record<string, string>> = {}): VirtualProjectFixture => {
  const rootResult = asCanonicalPath("/virtual/project");
  if (!rootResult.ok) throw new Error(rootResult.error.message);
  const fs = new FakeFileSystem();
  const paths: Record<string, SafeProjectPath> = {};
  for (const [path, content] of Object.entries(files)) {
    const safe = asSafeProjectPath(path);
    if (!safe.ok) throw new Error(safe.error.message);
    paths[path] = safe.value;
    fs.seed(path, content);
  }
  return { root: rootResult.value, fs, files: paths };
};

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
