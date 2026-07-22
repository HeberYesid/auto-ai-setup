import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type { ProjectEntry, ProjectEntryKind, ProjectValidationPort } from "../src/domain/index.js";
import { NodeProjectGateway, NodeProjectValidationPort } from "../src/infrastructure/fs/project-gateway.js";
import { deterministicFastCheckParameters } from "./support/fast-check.js";

type FailurePoint = "none" | "stat" | "realpath" | "enumerate" | "readEvidence" | "writeProbe" | "readProbe";

const failureArbitrary = fc.constantFrom<FailurePoint>(
  "none", "stat", "realpath", "enumerate", "readEvidence", "writeProbe", "readProbe",
);
const projectFileArbitrary = fc.uniqueArray(
  fc.constantFrom("package.json", "src/index.ts", "README.md", ".kiro/settings/mcp.json"),
  { maxLength: 4 },
);
const probeSuffix = ".auto-ai-setup.validation-property.tmp";
const canonicalVirtualRoot = "/virtual/canonical";

class VirtualValidationPort implements ProjectValidationPort {
  readonly files = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  constructor(readonly failure: FailurePoint, fileNames: readonly string[]) {
    for (const name of fileNames) this.files.set(`${canonicalVirtualRoot}/${name}`, new TextEncoder().encode(`content:${name}`));
  }
  async stat(): Promise<ProjectEntryKind> {
    this.throwIf("stat");
    return "directory";
  }
  async realpath(): Promise<string> {
    this.throwIf("realpath");
    return canonicalVirtualRoot;
  }
  async enumerate(): Promise<readonly ProjectEntry[]> {
    this.throwIf("enumerate");
    return [...this.files.keys()].map((absolutePath) => ({
      absolutePath,
      relativePath: absolutePath.slice(canonicalVirtualRoot.length + 1),
      kind: "file" as const,
      bytes: this.files.get(absolutePath)?.byteLength,
    }));
  }
  async readFile(path: string): Promise<Uint8Array> {
    if (this.failure === "readProbe" && path.endsWith(probeSuffix)) throw new Error("injected probe read failure");
    if (this.failure === "readEvidence" && !path.endsWith(probeSuffix)) throw new Error("injected evidence read failure");
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing ${path}`);
    return content.slice();
  }
  async writeFile(path: string, content: Uint8Array): Promise<void> {
    if (this.failure === "writeProbe") throw new Error("injected probe write failure");
    this.files.set(path, content.slice());
  }
  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
  snapshot(): readonly string[] {
    return [...this.files.entries()].map(([path, content]) => `${path}:${Array.from(content).join(",")}`).sort();
  }
  private throwIf(point: FailurePoint): void {
    if (this.failure === point) throw new Error(`injected ${point} failure`);
  }
}

class InjectingRealValidationPort implements ProjectValidationPort {
  private readonly delegate = new NodeProjectValidationPort();
  constructor(readonly failure: FailurePoint) {}
  async stat(path: string): Promise<ProjectEntryKind> {
    this.throwIf("stat");
    return this.delegate.stat(path);
  }
  async realpath(path: string): Promise<string> {
    this.throwIf("realpath");
    return this.delegate.realpath(path);
  }
  async enumerate(root: string): Promise<readonly ProjectEntry[]> {
    this.throwIf("enumerate");
    return this.delegate.enumerate(root);
  }
  async readFile(path: string): Promise<Uint8Array> {
    if (this.failure === "readProbe" && path.endsWith(probeSuffix)) throw new Error("injected probe read failure");
    if (this.failure === "readEvidence" && !path.endsWith(probeSuffix)) throw new Error("injected evidence read failure");
    return this.delegate.readFile(path);
  }
  async writeFile(path: string, content: Uint8Array): Promise<void> {
    if (this.failure === "writeProbe") throw new Error("injected probe write failure");
    return this.delegate.writeFile(path, content);
  }
  async removeFile(path: string): Promise<void> { return this.delegate.removeFile(path); }
  private throwIf(point: FailurePoint): void {
    if (this.failure === point) throw new Error(`injected ${point} failure`);
  }
}

class CountingValidationPort implements ProjectValidationPort {
  private readonly files = new Map<string, Uint8Array>();

  constructor(private readonly projectFileCount: number) {}

  async stat(): Promise<ProjectEntryKind> { return "directory"; }
  async realpath(): Promise<string> { return canonicalVirtualRoot; }
  async enumerate(): Promise<readonly ProjectEntry[]> {
    return Array.from({ length: this.projectFileCount }, (_, index) => ({
      absolutePath: `${canonicalVirtualRoot}/project-${index}.md`,
      relativePath: `project-${index}.md`,
      kind: "file" as const,
      bytes: 0,
    }));
  }
  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing ${path}`);
    return content.slice();
  }
  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content.slice());
  }
  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const virtualSnapshotArbitrary = projectFileArbitrary.map((files) => files.map((name) => name));
const projectFileCountArbitrary = fc.nat({ max: 1_000 });

describe("Property 1: validar un directorio no deja efectos y canoniza el root", () => {
  it("preserves the virtual-project snapshot and returns exit code 2 for every injected validation failure", async () => {
    await fc.assert(
      fc.asyncProperty(virtualSnapshotArbitrary, failureArbitrary, async (fileNames, failure) => {
        const filesystem = new VirtualValidationPort(failure, fileNames);
        const before = filesystem.snapshot();
        const gateway = new NodeProjectGateway(filesystem, { probeName: () => "property" });
        const result = await gateway.validateDirectory("/virtual/input");

        const shouldSucceed = failure === "none" || (failure === "readEvidence" && fileNames.length === 0);
        if (shouldSucceed) {
          expect(result).toEqual({
            ok: true,
            value: expect.objectContaining({ root: canonicalVirtualRoot }),
          });
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.exitCode).toBe(2);
        }
        expect(filesystem.snapshot()).toEqual(before);
        const probePath = `${canonicalVirtualRoot}/${probeSuffix}`;
        expect(filesystem.files.has(probePath)).toBe(false);
        if (failure === "readProbe") {
          expect(filesystem.removed.map(normalizePath)).toContain(normalizePath(probePath));
        }
      }),
      deterministicFastCheckParameters(24024, 40),
    );
  });

  it("preserves real temporary directories, cleans probes, and canonicalizes successful roots", async () => {
    await fc.assert(
      fc.asyncProperty(failureArbitrary, async (failure) => {
        const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-property-"));
        const sourcePath = join(root, "src");
        await (await import("node:fs/promises")).mkdir(sourcePath, { recursive: true });
        await writeFile(join(root, "package.json"), "{}\n");
        await writeFile(join(sourcePath, "index.ts"), "export {};\n");
        await writeFile(join(root, "README.md"), "project\n");
        const before = await realSnapshot(root);
        try {
          const gateway = new NodeProjectGateway(new InjectingRealValidationPort(failure), { probeName: () => "property" });
          const result = await gateway.validateDirectory(root);
          const probePath = join(root, probeSuffix);

          if (failure === "none") {
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.value.root).toBe(await (await import("node:fs/promises")).realpath(root));
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.exitCode).toBe(2);
          }
          expect(await realSnapshot(root)).toEqual(before);
          await expect(readFile(probePath)).rejects.toThrow();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      deterministicFastCheckParameters(24025, 20),
    );
  });
});

// Feature: auto-ai-setup, Property 2: Clasificación total por cantidad de archivos de proyecto
// **Validates: Requirements 1.11, 1.12**
describe("Property 2: clasificación total por cantidad de archivos de proyecto", () => {
  it("classifies every generated non-negative project-file count at the zero boundary", async () => {
    await fc.assert(
      fc.asyncProperty(projectFileCountArbitrary, async (projectFileCount) => {
        const gateway = new NodeProjectGateway(new CountingValidationPort(projectFileCount), { probeName: () => "property" });
        const result = await gateway.validateDirectory("/virtual/input");

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.projectFileCount).toBe(projectFileCount);
          expect(result.value.kind).toBe(projectFileCount === 0 ? "new" : "existing");
        }
      }),
      deterministicFastCheckParameters(24026, 100),
    );
  });
});

const realSnapshot = async (root: string): Promise<readonly string[]> => {
  const entries: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        entries.push(`${relative(root, absolute).split(sep).join("/")}:${Array.from(bytes).join(",")}`);
      }
    }
  };
  await visit(root);
  return entries.sort();
};

const normalizePath = (path: string): string => path.split("\\").join("/");
