import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EventFactory, EventSink, Clock, UuidGenerator } from "../../domain/index.js";
import type { ExecutionSummary, LocalEvent, RedactedEvent } from "../../domain/index.js";
import type { CanonicalPath, RunId } from "../../domain/index.js";
import { SecretRedactor } from "../../domain/security/redaction.js";

export interface EventFactoryOptions {
  readonly clock: Clock;
  readonly runId?: RunId;
  readonly uuid?: UuidGenerator;
  readonly verbose?: boolean;
  readonly redactor?: SecretRedactor;
}

export class LocalEventFactory implements EventFactory {
  private readonly redactor: SecretRedactor;
  public constructor(private readonly options: EventFactoryOptions) {
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  public create(input: Omit<LocalEvent, "timestamp">): RedactedEvent {
    const context =
      this.options.verbose === true && input.context !== undefined
        ? (this.redactor.redact(input.context) as Readonly<Record<string, unknown>>)
        : undefined;
    return {
      runId: input.runId,
      timestamp: this.options.clock.now(),
      level: input.level,
      category: input.category,
      message: String(this.redactor.redact(input.message)),
      ...(context === undefined ? {} : { context }),
      redacted: true,
    };
  }
}

export interface LocalEventSinkOptions {
  readonly root?: CanonicalPath;
  readonly filePath?: string;
  readonly terminal?: (line: string) => void;
  readonly redactor?: SecretRedactor;
}

const localPath = (root: CanonicalPath, candidate: string): string | undefined => {
  const rootPath = resolve(root);
  const target = resolve(rootPath, candidate);
  const remainder = relative(rootPath, target);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) return undefined;
  return target;
};

/** Local-only JSONL event sink. It never accepts a destination outside root. */
export class LocalEventSink implements EventSink {
  private readonly redactor: SecretRedactor;
  private readonly target: string | undefined;
  private readonly terminal: (line: string) => void;
  public constructor(options: LocalEventSinkOptions = {}) {
    this.redactor = options.redactor ?? new SecretRedactor();
    this.terminal = options.terminal ?? ((line) => console.log(line));
    this.target = options.filePath === undefined || options.root === undefined ? undefined : localPath(options.root, options.filePath);
    if (options.filePath !== undefined && options.root !== undefined && this.target === undefined)
      throw new Error("Event sink file must be project-local");
  }

  public emit(event: LocalEvent): void {
    const redacted = this.redactor.redact(event) as RedactedEvent;
    const line = JSON.stringify(redacted);
    try {
      if (this.target !== undefined) {
        mkdirSync(dirname(this.target), { recursive: true });
        appendFileSync(this.target, `${line}\n`, { encoding: "utf8" });
      } else {
        this.terminal(line);
      }
    } catch {
      // Do not expose filesystem causes or event content through a secondary sink.
      try {
        this.terminal(
          JSON.stringify({
            runId: event.runId,
            timestamp: event.timestamp,
            level: "error",
            category: "security",
            message: "Unable to write local event",
          }),
        );
      } catch {
        /* terminal is best effort */
      }
    }
  }
}

export const createEventFactory = (options: EventFactoryOptions): EventFactory => new LocalEventFactory(options);

export const mapSummaryToEvents = (summary: ExecutionSummary, clock: Clock, redactor = new SecretRedactor()): readonly RedactedEvent[] => {
  const make = (level: LocalEvent["level"], message: string, context?: Readonly<Record<string, unknown>>): RedactedEvent => ({
    runId: summary.runId,
    timestamp: clock.now(),
    level,
    category: "session",
    message: String(redactor.redact(message)),
    ...(context === undefined ? {} : { context: redactor.redact(context) as Readonly<Record<string, unknown>> }),
    redacted: true,
  });
  const events: RedactedEvent[] = [
    make(summary.status === "success" || summary.status === "cancelled" ? "info" : "error", `Run ${summary.status}`, {
      exitCode: summary.exitCode,
    }),
  ];
  for (const value of summary.applied) events.push(make("info", "Change applied", { id: value }));
  for (const value of summary.skipped) events.push(make("info", "Change skipped", { id: value }));
  for (const value of summary.warnings) events.push(make("warn", "Warning", { cause: value }));
  for (const value of summary.errors) events.push(make("error", "Error", { cause: value }));
  return events;
};

export const EventSinkLocal = LocalEventSink;
