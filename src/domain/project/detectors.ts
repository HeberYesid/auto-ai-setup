import type { StackDetectorRegistry } from "../shared/ports.js";
import type { SafeProjectPath } from "../shared/types.js";
import type { DetectionClaim, FilePattern, ParsedEvidence, StackCategory, StackDetector, StackEvidence } from "./models.js";

const packageFiles: readonly FilePattern[] = [{ pattern: "package.json", format: "json" }, { pattern: "package-lock.json", format: "lockfile" }, { pattern: "pnpm-lock.yaml", format: "yaml" }, { pattern: "yarn.lock", format: "lockfile" }, { pattern: "bun.lockb", format: "lockfile" }];
const pythonFiles: readonly FilePattern[] = [{ pattern: "pyproject.toml", format: "toml" }, { pattern: "requirements.txt", format: "lockfile" }, { pattern: "poetry.lock", format: "lockfile" }, { pattern: "uv.lock", format: "lockfile" }];
const rubyFiles: readonly FilePattern[] = [{ pattern: "Gemfile", format: "lockfile" }, { pattern: "Gemfile.lock", format: "lockfile" }];
const phpFiles: readonly FilePattern[] = [{ pattern: "composer.json", format: "json" }, { pattern: "composer.lock", format: "lockfile" }];

const claim = (category: StackCategory, id: string, displayName: string, confidence: "explicit" | "derived", file: ParsedEvidence, value: string, detectorId: string, location = "1:1"): DetectionClaim => ({
  category, id, displayName, confidence,
  evidence: { path: file.path, format: file.format, location, recognizedValue: value, detectorId },
});

const text = (file: ParsedEvidence): string => new TextDecoder().decode(file.source);
const json = (file: ParsedEvidence): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text(file));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
};
const objectField = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};
const hasDependency = (manifest: Record<string, unknown>, names: readonly string[]): string | undefined => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = objectField(manifest[field]);
    if (dependencies === undefined) continue;
    const found = names.find((name) => dependencies[name] !== undefined);
    if (found !== undefined) return found;
  }
  return undefined;
};
const hasTextDependency = (source: string, names: readonly string[]): string | undefined => names.find((name) => new RegExp(`(?:^|[\\s"'])${escapeRegExp(name)}(?:$|[\\s"'=:/])`, "imu").test(source));
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const valid = (file: ParsedEvidence): boolean => file.validSyntax && file.validSchema;
const packageManagerDetector = (id: string, files: readonly FilePattern[], manager: string, names: readonly string[] = []): StackDetector => ({
  id: `package-manager.${id}`, acceptedFiles: files, detect: (file) => {
    if (!valid(file)) return [];
    const name = file.path.split("/").pop()?.toLowerCase() ?? "";
    const explicit = names.includes(name) || (name === "package.json" && id === "npm");
    if (!explicit) return [];
    return [claim("package-manager", id, manager, "explicit", file, name, `package-manager.${id}`)];
  },
});

const languageDetector = (id: string, displayName: string, extensions: readonly string[], files: readonly FilePattern[]): StackDetector => ({
  id: `language.${id}`, acceptedFiles: files, detect: (file) => {
    if (!valid(file)) return [];
    const path = file.path.toLowerCase();
    const extension = path.includes(".") ? `.${path.split(".").pop() ?? ""}` : "";
    if (!extensions.includes(extension) && !files.some((entry) => entry.pattern === path.split("/").pop())) return [];
    return [claim("language", id, displayName, file.format === "source-extension" ? "derived" : "explicit", file, file.path, `language.${id}`)];
  },
});

const packageDependencyDetector = (id: string, displayName: string, names: readonly string[], category: StackCategory, files: readonly FilePattern[] = packageFiles): StackDetector => ({
  id, acceptedFiles: files, detect: (file) => {
    if (!valid(file)) return [];
    const manifest = file.format === "json" ? json(file) : undefined;
    const found = manifest === undefined ? hasTextDependency(text(file), names) : hasDependency(manifest, names);
    if (found === undefined) return [];
    return [claim(category, id, displayName, "explicit", file, `${found}=present`, id)];
  },
});

const textDetector = (id: string, displayName: string, names: readonly string[], category: StackCategory, files: readonly FilePattern[]): StackDetector => ({
  id, acceptedFiles: files, detect: (file) => {
    if (!valid(file)) return [];
    const found = hasTextDependency(text(file), names);
    return found === undefined ? [] : [claim(category, id, displayName, "explicit", file, `${found}=present`, id)];
  },
});

const sourcePatterns = (extensions: readonly string[]): readonly FilePattern[] => extensions.map((extension) => ({ pattern: `*${extension}`, format: "source-extension" as const }));

const detectors: readonly StackDetector[] = [
  languageDetector("javascript", "JavaScript", [".js", ".jsx", ".mjs", ".cjs"], [...sourcePatterns([".js", ".jsx", ".mjs", ".cjs"]), ...packageFiles, { pattern: "tsconfig.json", format: "json" }]),
  languageDetector("typescript", "TypeScript", [".ts", ".tsx", ".mts", ".cts"], [...sourcePatterns([".ts", ".tsx", ".mts", ".cts"]), ...packageFiles, { pattern: "tsconfig.json", format: "json" }]),
  languageDetector("python", "Python", [".py"], [...sourcePatterns([".py"]), ...pythonFiles]),
  languageDetector("ruby", "Ruby", [".rb"], [...sourcePatterns([".rb"]), ...rubyFiles]),
  languageDetector("php", "PHP", [".php"], [...sourcePatterns([".php"]), ...phpFiles]),
  packageManagerDetector("npm", packageFiles, "npm", ["package-lock.json"]),
  packageManagerDetector("pnpm", packageFiles, "pnpm", ["pnpm-lock.yaml"]),
  packageManagerDetector("yarn", packageFiles, "Yarn", ["yarn.lock"]),
  packageManagerDetector("bun", packageFiles, "Bun", ["bun.lockb"]),
  packageManagerDetector("pip", pythonFiles, "pip", ["requirements.txt"]),
  packageManagerDetector("poetry", pythonFiles, "Poetry", ["poetry.lock"]),
  packageManagerDetector("uv", pythonFiles, "uv", ["uv.lock"]),
  packageManagerDetector("bundler", rubyFiles, "Bundler", ["gemfile", "gemfile.lock"]),
  packageManagerDetector("composer", phpFiles, "Composer", ["composer.json", "composer.lock"]),
  packageDependencyDetector("framework.react", "React", ["react"], "framework"),
  packageDependencyDetector("framework.next", "Next.js", ["next"], "framework"),
  packageDependencyDetector("framework.vue", "Vue", ["vue"], "framework"),
  packageDependencyDetector("framework.svelte", "Svelte", ["svelte"], "framework"),
  packageDependencyDetector("framework.express", "Express", ["express"], "framework"),
  packageDependencyDetector("framework.nestjs", "NestJS", ["@nestjs/core"], "framework"),
  textDetector("framework.django", "Django", ["django"], "framework", pythonFiles),
  textDetector("framework.fastapi", "FastAPI", ["fastapi"], "framework", pythonFiles),
  textDetector("framework.rails", "Rails", ["rails"], "framework", rubyFiles),
  textDetector("framework.laravel", "Laravel", ["laravel/framework"], "framework", phpFiles),
  packageDependencyDetector("tool.vitest", "Vitest", ["vitest"], "tool"),
  packageDependencyDetector("tool.jest", "Jest", ["jest"], "tool"),
  packageDependencyDetector("tool.playwright", "Playwright", ["@playwright/test", "playwright"], "tool"),
  packageDependencyDetector("tool.eslint", "ESLint", ["eslint"], "tool"),
  packageDependencyDetector("tool.prettier", "Prettier", ["prettier"], "tool"),
  packageDependencyDetector("tool.tailwind", "Tailwind", ["tailwindcss"], "tool"),
  packageDependencyDetector("tool.prisma", "Prisma", ["prisma", "@prisma/client"], "tool"),
  packageDependencyDetector("tool.supabase", "Supabase", ["@supabase/supabase-js", "supabase"], "tool"),
  packageDependencyDetector("tool.vercel", "Vercel", ["vercel"], "tool"),
  textDetector("tool.github-actions", "GitHub Actions", ["name:", "on:"], "tool", [{ pattern: "**/.github/workflows/*.yml", format: "yaml" }, { pattern: "**/.github/workflows/*.yaml", format: "yaml" }]),
];

const matches = (path: string, pattern: FilePattern): boolean => {
  const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
  const normalizedPattern = pattern.pattern.toLowerCase();
  if (normalizedPattern.startsWith("**/")) {
    const suffix = normalizedPattern.slice(3).replace("*", "");
    return normalizedPath.includes(suffix.slice(0, suffix.lastIndexOf("/"))) && normalizedPath.endsWith(suffix.slice(suffix.lastIndexOf("/") + 1));
  }
  const basename = normalizedPath.split("/").pop() ?? "";
  if (normalizedPattern.startsWith("*")) return basename.endsWith(normalizedPattern.slice(1));
  return basename === normalizedPattern;
};

export const detectionEvidence = (claimValue: DetectionClaim): StackEvidence => claimValue.evidence;

const configDetector = (id: string, displayName: string, names: readonly string[], category: StackCategory): StackDetector => ({
  id, acceptedFiles: names.map((name) => ({ pattern: name, format: name.endsWith(".json") ? "json" : name.endsWith(".toml") ? "toml" : "source-extension" })),
  detect: (file) => {
    if (!valid(file)) return [];
    const name = file.path.split("/").pop()?.toLowerCase() ?? "";
    return names.includes(name) ? [claim(category, id, displayName, "explicit", file, name, id)] : [];
  },
});

const configDetectors: readonly StackDetector[] = [
  configDetector("tool.playwright.config", "Playwright", ["playwright.config.js", "playwright.config.ts", "playwright.config.mjs"], "tool"),
  configDetector("tool.eslint.config", "ESLint", [".eslintrc.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts"], "tool"),
  configDetector("tool.prettier.config", "Prettier", [".prettierrc", ".prettierrc.json", "prettier.config.js", "prettier.config.cjs"], "tool"),
  configDetector("tool.tailwind.config", "Tailwind", ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs"], "tool"),
  configDetector("tool.prisma.config", "Prisma", ["schema.prisma"], "tool"),
  configDetector("tool.supabase.config", "Supabase", ["config.toml"], "tool"),
  configDetector("tool.vercel.config", "Vercel", ["vercel.json"], "tool"),
];

const allDetectors: readonly StackDetector[] = [...detectors, ...configDetectors];

export class DefaultStackDetectorRegistry implements StackDetectorRegistry {
  readonly detectors = allDetectors;
  find(path: SafeProjectPath): readonly StackDetector[] {
    return this.detectors.filter((detector) => detector.acceptedFiles.some((pattern) => matches(path, pattern)));
  }
}

export const createDefaultDetectorRegistry = (): StackDetectorRegistry => new DefaultStackDetectorRegistry();
export const supportedStackDetectors: readonly StackDetector[] = allDetectors;
