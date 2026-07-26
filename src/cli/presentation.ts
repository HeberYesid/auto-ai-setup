/**
 * Human-facing presentation for the line-oriented CLI.
 *
 * Everything in this module is pure: it turns an already-redacted plan or component catalog into an
 * ordered list of ready-to-write lines. No terminal, filesystem, or environment access happens here,
 * so the exact rendering is deterministic and directly assertable in tests. Styling is opt-in: when
 * `color` is disabled not a single escape byte is produced, which keeps piped and non-TTY output
 * plain, and keeps the rendered text stable for assertions.
 */

import type { ChangePlan, ComponentDefinition, ComponentSelectionView, FileChange } from "../domain/index.js";

/** Presentation preferences resolved at the CLI boundary. */
export interface PresentationOptions {
  /** Emit ANSI styling. Disabled for non-TTY output, `NO_COLOR`, and tests. */
  readonly color: boolean;
  /** Use box-drawing and bullet glyphs instead of ASCII fallbacks. */
  readonly unicode: boolean;
  /** Usable terminal width, clamped to a readable range. */
  readonly width: number;
  /** Show untruncated values and raw JSON instead of summaries. */
  readonly verbose: boolean;
}

export const defaultPresentationOptions: PresentationOptions = { color: false, unicode: true, width: 96, verbose: false };

type Styler = (value: string) => string;

interface Style {
  readonly bold: Styler;
  readonly dim: Styler;
  readonly green: Styler;
  readonly yellow: Styler;
  readonly red: Styler;
  readonly cyan: Styler;
}

const wrap =
  (code: string, enabled: boolean): Styler =>
  (value) =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;

/** Build a styler set. With `color` disabled every styler is the identity function. */
export const createStyle = (color: boolean): Style => ({
  bold: wrap("1", color),
  dim: wrap("2", color),
  green: wrap("32", color),
  yellow: wrap("33", color),
  red: wrap("31", color),
  cyan: wrap("36", color),
});

interface Glyphs {
  readonly heavy: string;
  readonly light: string;
  readonly bullet: string;
  readonly arrow: string;
  readonly separator: string;
}

const glyphsFor = (unicode: boolean): Glyphs =>
  unicode
    ? { heavy: "═", light: "─", bullet: "•", arrow: "→", separator: "·" }
    : { heavy: "=", light: "-", bullet: "*", arrow: "->", separator: "-" };

const clampWidth = (width: number): number => Math.max(48, Math.min(100, Math.trunc(width) || 96));

const rule = (glyph: string, width: number): string => glyph.repeat(clampWidth(width));

/** Field label padded so every value in a block starts at the same column. */
const LABEL_WIDTH = 11;
const label = (text: string): string => (text === "" ? " ".repeat(LABEL_WIDTH) : `${text}:`.padEnd(LABEL_WIDTH, " "));

const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`);

/** Collapse whitespace so a multi-line reason never breaks the aligned layout. */
const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

const plural = (count: number, singular: string, many: string): string => `${count} ${count === 1 ? singular : many}`;

/** Word-wrap a single-line string. Words longer than the limit are left intact rather than cut. */
const wrapText = (text: string, width: number): readonly string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
};

/**
 * A labeled field, wrapped to the terminal width with a hanging indent so continuation lines stay
 * aligned under the value instead of under the label.
 */
const field = (indent: string, labelText: string, value: string, options: PresentationOptions, style: Style): readonly string[] => {
  const available = Math.max(24, clampWidth(options.width) - indent.length - LABEL_WIDTH);
  return wrapText(oneLine(value), available).map((line, index) => `${indent}${style.dim(label(index === 0 ? labelText : ""))}${line}`);
};

const relativeDestination = (root: string, destination: string): string => {
  const normalizedRoot = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalized = destination.replace(/\\/gu, "/").replace(/^\/+/u, "");
  return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized;
};

const ACTION_LABELS: Record<string, string> = {
  create: "CREAR",
  modify: "EDITAR",
  preserve: "MANTENER",
  skip: "OMITIR",
};

const actionLabel = (action: string): string => ACTION_LABELS[action] ?? action.toUpperCase();

const CONFLICT_LABELS: Record<string, string> = {
  none: "ninguno",
  "content-differs": "el archivo ya existe con otro contenido",
  "invalid-managed-markers": "los marcadores gestionados del archivo no son válidos",
  "ownership-unknown": "no se puede determinar quién es dueño del archivo",
};

const conflictLabel = (conflict: string): string => CONFLICT_LABELS[conflict] ?? conflict;

const FIELD_GLYPHS: Record<string, string> = { add: "+", remove: "-", replace: "~" };

const FIELD_LABELS: Record<string, string> = { add: "añade", remove: "quita", replace: "reemplaza" };

/**
 * Describe a configuration value in one short, readable phrase instead of dumping raw JSON. Large
 * objects and arrays are summarized by size and by their first keys, which is what a reviewer needs
 * to decide, while `--verbose` keeps the full serialization available.
 */
export const describeValue = (value: unknown, verbose = false): string => {
  if (value === undefined) return "(no existía)";
  if (value === null) return "null";
  if (verbose) return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `lista de ${plural(value.length, "elemento", "elementos")}`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "objeto vacío";
    const shown = keys.slice(0, 3).join(", ");
    const rest = keys.length - Math.min(keys.length, 3);
    return `objeto con ${plural(keys.length, "clave", "claves")}: ${shown}${rest > 0 ? `, +${String(rest)} más` : ""}`;
  }
  if (typeof value === "string") return truncate(JSON.stringify(value), 72);
  return String(value);
};

const PREVIEW_LINES = 6;

const textPreviewLines = (content: string, options: PresentationOptions, indent: string, style: Style): readonly string[] => {
  const all = content.replace(/\r\n/gu, "\n").split("\n");
  const shown = options.verbose ? all : all.slice(0, PREVIEW_LINES);
  const hidden = all.length - shown.length;
  const body = shown.map((line) => `${indent}${style.dim(`| ${truncate(line, clampWidth(options.width) - indent.length - 2)}`)}`);
  return hidden > 0 ? [...body, `${indent}${style.dim(`| … ${plural(hidden, "línea más", "líneas más")}`)}`] : body;
};

const structuredPreviewLines = (
  changes: readonly { readonly path: string; readonly action: string; readonly before?: unknown; readonly after?: unknown }[],
  options: PresentationOptions,
  indent: string,
  style: Style,
): readonly string[] =>
  changes.map((field) => {
    const glyph = FIELD_GLYPHS[field.action] ?? "~";
    const verb = FIELD_LABELS[field.action] ?? field.action;
    const paint = field.action === "remove" ? style.red : field.action === "add" ? style.green : style.yellow;
    const after = describeValue(field.after, options.verbose);
    const detail =
      field.action === "replace"
        ? `${describeValue(field.before, options.verbose)} ${glyphsFor(options.unicode).arrow} ${after}`
        : field.action === "remove"
          ? describeValue(field.before, options.verbose)
          : after;
    return `${indent}${paint(`${glyph} ${verb} ${field.path}`)} ${style.dim(glyphsFor(options.unicode).separator)} ${detail}`;
  });

const previewLines = (change: FileChange, options: PresentationOptions, indent: string, style: Style): readonly string[] => {
  const preview = change.preview as
    | { readonly kind: "text"; readonly content: string }
    | { readonly kind: "structured"; readonly changes: readonly { readonly path: string; readonly action: string }[] };
  if (preview.kind === "text") return textPreviewLines(preview.content, options, indent, style);
  return structuredPreviewLines(preview.changes as never, options, indent, style);
};

const planSummary = (plan: ChangePlan): string => {
  const counts = new Map<string, number>();
  for (const change of plan.fileChanges) counts.set(change.action, (counts.get(change.action) ?? 0) + 1);
  const parts: string[] = [];
  for (const [action, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
    parts.push(`${String(count)} ${actionLabel(action).toLowerCase()}`);
  if (plan.externalOperations.length > 0) parts.push(plural(plan.externalOperations.length, "operación externa", "operaciones externas"));
  const recommendations = plan.cliRecommendations ?? [];
  if (recommendations.length > 0) parts.push(plural(recommendations.length, "CLI recomendada", "CLIs recomendadas"));
  return parts.length === 0 ? "nada que aplicar" : parts.join(", ");
};

/**
 * Render the review report for an already-redacted plan.
 *
 * The report is organized top-down: what the run is about to do in one line, then the informative
 * sections (recommendations, which are never executed), then the concrete file changes, then the
 * external operations that require their own authorization. Paths are shown relative to the project
 * root, which is printed once, so a reviewer reads short, comparable paths.
 */
export const formatPlanReport = (plan: ChangePlan, options: PresentationOptions = defaultPresentationOptions): readonly string[] => {
  const style = createStyle(options.color);
  const glyphs = glyphsFor(options.unicode);
  const width = clampWidth(options.width);
  const lines: string[] = [""];

  lines.push(style.bold(rule(glyphs.heavy, width)));
  lines.push(style.bold("  PLAN DE CAMBIOS"));
  lines.push(`  ${style.dim("proyecto:")} ${plan.root.replace(/\\/gu, "/")}`);
  lines.push(`  ${style.dim("resumen: ")} ${planSummary(plan)}`);
  lines.push(`  ${style.dim("huella:  ")} ${style.dim(plan.planHash)}`);
  lines.push(style.bold(rule(glyphs.heavy, width)));

  if (plan.fileChanges.length === 0 && plan.externalOperations.length === 0) {
    lines.push("");
    lines.push(`  ${style.yellow("El plan no contiene cambios: no hay nada que aprobar ni que revertir.")}`);
    lines.push("");
    return lines;
  }

  const recommendations = plan.cliRecommendations ?? [];
  if (recommendations.length > 0) {
    lines.push("");
    lines.push(style.bold(`CLIs RECOMENDADAS (${String(recommendations.length)})`));
    lines.push(style.dim("  Solo se documentan. auto-ai-setup no las instala, no las ejecuta y no las comprueba."));
    recommendations.forEach((recommendation, index) => {
      lines.push("");
      lines.push(`  ${style.cyan(`${String(index + 1)}. ${recommendation.cli}`)}`);
      lines.push(...field("     ", "por qué", recommendation.reason, options, style));
      const technologies = (recommendation.technologies ?? []).join(", ");
      if (technologies !== "") lines.push(...field("     ", "stack", technologies, options, style));
      lines.push(...field("     ", "evidencia", recommendation.evidenceRefs.join(", ") || "no disponible", options, style));
      for (const instruction of recommendation.documentedInstructions ?? [])
        lines.push(...field("     ", "", `${glyphs.bullet} ${oneLine(instruction)}`, options, style));
    });
  }

  if (plan.fileChanges.length > 0) {
    lines.push("");
    lines.push(style.bold(`ARCHIVOS (${String(plan.fileChanges.length)})`));
    lines.push(style.dim(`  Rutas relativas al proyecto. Nada se escribe hasta que apruebes el plan.`));
    plan.fileChanges.forEach((change, index) => {
      const paint = change.action === "create" ? style.green : change.action === "modify" ? style.yellow : style.dim;
      lines.push("");
      lines.push(
        `  ${style.dim(`[${String(index + 1)}]`)} ${paint(actionLabel(change.action).padEnd(6, " "))} ${style.bold(relativeDestination(plan.root, change.destination))}`,
      );
      lines.push(`      ${style.dim(label("aporta"))}${change.componentId}`);
      lines.push(...field("      ", "motivo", change.reason, options, style));
      const conflicted = change.conflict !== "none";
      lines.push(
        `      ${style.dim(label("conflicto"))}${conflicted ? style.yellow(conflictLabel(change.conflict)) : style.dim(conflictLabel(change.conflict))}`,
      );
      const preview = previewLines(change, options, "      ", style);
      if (preview.length > 0) {
        lines.push(`      ${style.dim(label("contenido"))}`);
        lines.push(...preview);
      }
    });
  }

  if (plan.externalOperations.length > 0) {
    lines.push("");
    lines.push(style.bold(`OPERACIONES EXTERNAS (${String(plan.externalOperations.length)})`));
    lines.push(style.dim("  Se autorizan una por una y quedan fuera de la transacción de auto-ai-setup."));
    plan.externalOperations.forEach((operation, index) => {
      lines.push("");
      lines.push(`  ${style.dim(`[${String(index + 1)}]`)} ${style.cyan(operation.id)}`);
      lines.push(`      ${style.dim(label("comando"))}${operation.command.join(" ")}`);
      lines.push(`      ${style.dim(label("origen"))}${operation.origin}`);
      lines.push(`      ${style.dim(label("destino"))}${relativeDestination(plan.root, operation.destination)}`);
      lines.push(...field("      ", "propósito", operation.purpose, options, style));
      lines.push(`      ${style.dim(label("red"))}${operation.usesNetwork ? style.yellow("sí, descarga desde Internet") : "no"}`);
    });
  }

  lines.push("");
  lines.push(style.dim(rule(glyphs.light, width)));
  return lines;
};

const componentTypeLabel = (type: ComponentDefinition["type"]): string =>
  ({
    skill: "Skills",
    "mcp-server": "Servidores MCP",
    "agent-rule": "Reglas de agente",
    "agent-command": "Comandos de agente",
    "agent-hook": "Hooks de agente",
  })[type];

/** One catalog entry paired with the number a user may type instead of its id. */
export interface NumberedComponent {
  readonly index: number;
  readonly id: string;
}

export interface ComponentCatalogRender {
  readonly lines: readonly string[];
  /** Stable number-to-id mapping so numeric answers resolve to exactly what was displayed. */
  readonly numbered: readonly NumberedComponent[];
}

/**
 * Render the component catalog with a stable numbering. Numbers exist so a user never has to retype
 * long identifiers; the identifier stays visible because it is what the plan and the events use.
 */
export const formatComponentCatalog = (
  view: ComponentSelectionView,
  mode: "auto" | "manual",
  options: PresentationOptions = defaultPresentationOptions,
): ComponentCatalogRender => {
  const style = createStyle(options.color);
  const glyphs = glyphsFor(options.unicode);
  const width = clampWidth(options.width);
  const lines: string[] = [""];
  const numbered: NumberedComponent[] = [];

  lines.push(style.bold(rule(glyphs.heavy, width)));
  lines.push(style.bold(mode === "auto" ? "  COMPONENTES DETECTADOS (modo automático)" : "  COMPONENTES DISPONIBLES"));
  lines.push(style.bold(rule(glyphs.heavy, width)));

  const recommendations = view.cliRecommendations ?? [];
  lines.push("");
  if (recommendations.length === 0) lines.push(style.dim("  CLIs recomendadas: ninguna para el stack confirmado."));
  else {
    lines.push(style.bold("  CLIs recomendadas") + style.dim(" (solo documentación; no se instalan ni se ejecutan)"));
    for (const recommendation of recommendations) {
      lines.push(`    ${style.cyan(recommendation.cli)} ${style.dim(glyphs.separator)} ${oneLine(recommendation.reason)}`);
      const technologies = (recommendation.technologies ?? []).join(", ");
      if (technologies !== "") lines.push(...field("      ", "stack", technologies, options, style));
      lines.push(...field("      ", "evidencia", recommendation.evidenceRefs.join(", ") || "no disponible", options, style));
      if (recommendation.explanation !== undefined) lines.push(...field("      ", "", recommendation.explanation, options, style));
    }
  }

  const groups = view.groups ?? [{ type: undefined, components: view.components }];
  for (const group of groups) {
    const groupComponents = group.components;
    if (groupComponents.length === 0) continue;
    lines.push("");
    lines.push(
      style.bold(`  ${group.type === undefined ? "Componentes" : componentTypeLabel(group.type)} (${String(groupComponents.length)})`),
    );
    for (const component of groupComponents) {
      const index = numbered.length + 1;
      numbered.push({ index, id: String(component.definition.id) });
      const compatible = component.compatibility.compatible;
      const status = compatible
        ? style.green("compatible")
        : style.yellow(`incompatible: ${component.compatibility.unsatisfied.join("; ")}`);
      lines.push(
        `    ${style.dim(`[${String(index)}]`)} ${style.bold(String(component.definition.id))} ${style.dim(glyphs.separator)} ${component.definition.name} ${status}`,
      );
      lines.push(
        ...wrapText(oneLine(component.definition.description), Math.max(24, width - 9)).map((line) => `         ${style.dim(line)}`),
      );
      if (component.origin !== undefined) lines.push(`         ${style.dim(label("origen"))}${component.origin}`);
      if (component.compatibility.evidenceRefs.length > 0)
        lines.push(`         ${style.dim(label("evidencia"))}${component.compatibility.evidenceRefs.join(", ")}`);
    }
  }

  lines.push("");
  return { lines, numbered };
};

/**
 * Resolve a free-form selection answer against the displayed catalog. Both the numbers shown in
 * brackets and the identifiers themselves are accepted, in any mix, so a user is never forced to
 * retype a long id. Unknown tokens are reported instead of being silently dropped.
 */
export const resolveSelectionAnswer = (
  answer: string,
  numbered: readonly NumberedComponent[],
): { readonly ids: readonly string[]; readonly unknown: readonly string[] } => {
  const tokens = [
    ...new Set(
      answer
        .split(/[\s,]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  const byId = new Map(numbered.map((entry) => [entry.id, entry.id]));
  const byIndex = new Map(numbered.map((entry) => [String(entry.index), entry.id]));
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const token of tokens) {
    if (token === "*" || token.toLowerCase() === "todos") {
      for (const entry of numbered) ids.push(entry.id);
      continue;
    }
    const resolved = byId.get(token) ?? byIndex.get(token);
    if (resolved === undefined) unresolved.push(token);
    else ids.push(resolved);
  }
  return { ids: [...new Set(ids)], unknown: unresolved };
};
