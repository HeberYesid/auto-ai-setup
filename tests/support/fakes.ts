import type {
  Clock,
  FileSystemPort,
  NetworkGateway,
  ProcessExecutor,
  ProcessResult,
  RegisteredProcessRequest,
  UserInteraction,
  UuidGenerator,
} from "../../src/domain/index.js";
import { asSafeProjectPath, ok } from "../../src/domain/index.js";
import type {
  ApprovalDecisions,
  ChangePlan,
  ComponentId,
  ComponentSelectionView,
  FileDescriptor,
  RedactedEvent,
  Result,
  SafeProjectPath,
  CanonicalPath,
  StackConflict,
  ConfirmedStack,
  ExternalOperation,
} from "../../src/domain/index.js";
import type { AppError, RunId, Sha256 } from "../../src/domain/index.js";

export type FailurePoint = "exists" | "read" | "write" | "remove" | "process" | "network";

export class FailureInjector {
  private readonly failures = new Map<FailurePoint, string>();

  failAt(point: FailurePoint, message = `Injected failure at ${point}`): void {
    this.failures.set(point, message);
  }

  clear(point?: FailurePoint): void {
    if (point === undefined) this.failures.clear();
    else this.failures.delete(point);
  }

  error(point: FailurePoint): Error | undefined {
    const message = this.failures.get(point);
    return message === undefined ? undefined : new Error(message);
  }
}

export class FakeClock implements Clock {
  private currentMs: number;
  private readonly startMs: number;
  constructor(startIso = "2025-01-01T00:00:00.000Z") {
    this.currentMs = Date.parse(startIso);
    this.startMs = this.currentMs;
  }
  now(): string { return new Date(this.currentMs).toISOString(); }
  monotonicMs(): number { return this.currentMs - this.startMs; }
  advance(ms: number): void { this.currentMs += ms; }
}

export class FakeUuidGenerator implements UuidGenerator {
  private nextValue = 0;
  constructor(private readonly prefix = "run") {}
  next(): RunId {
    this.nextValue += 1;
    return `${this.prefix}-${String(this.nextValue).padStart(4, "0")}` as RunId;
  }
}

export class FakeFileSystem implements FileSystemPort {
  private readonly files = new Map<SafeProjectPath, Uint8Array>();
  constructor(readonly failures = new FailureInjector()) {}

  seed(path: string, content: string | Uint8Array): void {
    const safe = asSafeProjectPath(path);
    if (!safe.ok) throw new Error(safe.error.message);
    this.files.set(safe.value, typeof content === "string" ? new TextEncoder().encode(content) : content.slice());
  }

  snapshot(): ReadonlyMap<SafeProjectPath, Uint8Array> {
    return new Map([...this.files].map(([path, bytes]) => [path, bytes.slice()]));
  }

  async exists(path: SafeProjectPath): Promise<boolean> {
    this.throwIfFailed("exists");
    return this.files.has(path);
  }
  async read(path: SafeProjectPath): Promise<Uint8Array> {
    this.throwIfFailed("read");
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`Missing virtual file: ${path}`);
    return bytes.slice();
  }
  async write(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    const failure = this.failures.error("write");
    if (failure) return { ok: false, error: this.ioError(failure.message) };
    this.files.set(path, content.slice());
    return ok(undefined);
  }
  async remove(path: SafeProjectPath): Promise<Result<void>> {
    const failure = this.failures.error("remove");
    if (failure) return { ok: false, error: this.ioError(failure.message) };
    this.files.delete(path);
    return ok(undefined);
  }
  async *list(root: CanonicalPath): AsyncIterable<FileDescriptor> {
    void root;
    for (const [path, bytes] of this.files) {
      yield { path, extension: path.includes(".") ? `.${path.split(".").pop() ?? ""}` : "", bytes: bytes.length as never, isSymlink: false };
    }
  }

  private throwIfFailed(point: "exists" | "read"): void {
    const failure = this.failures.error(point);
    if (failure) throw failure;
  }
  private ioError(message: string): AppError {
    return { code: "UNEXPECTED_ERROR", message, recoverability: "retry" };
  }
}

export class FakeProcessExecutor implements ProcessExecutor {
  readonly requests: RegisteredProcessRequest[] = [];
  result: ProcessResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, truncated: false };
  constructor(readonly failures = new FailureInjector()) {}
  async execute(request: RegisteredProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    void signal;
    this.requests.push(request);
    const failure = this.failures.error("process");
    if (failure) throw failure;
    return this.result;
  }
}

export class FakeNetworkGateway implements NetworkGateway {
  readonly requests: ExternalOperation[] = [];
  constructor(readonly failures = new FailureInjector()) {}
  async request(operation: ExternalOperation, approval: { readonly planHash: Sha256; readonly operationId: string; readonly approved: true }, signal?: AbortSignal): Promise<Result<Uint8Array, AppError>> {
    void approval;
    void signal;
    this.requests.push(operation);
    const failure = this.failures.error("network");
    if (failure) return { ok: false, error: { code: "NETWORK_DENIED", message: failure.message, recoverability: "retry" } };
    return ok(new Uint8Array());
  }
}

export interface ScriptedInteractionScript {
  readonly targets?: readonly string[];
  readonly modes?: readonly ("auto" | "manual")[];
  readonly stacks?: readonly ConfirmedStack[];
  readonly selections?: readonly (readonly ComponentId[])[];
  readonly approvals?: readonly ApprovalDecisions[];
}

export class ScriptedUserInteraction implements UserInteraction {
  readonly events: RedactedEvent[] = [];
  readonly plans: ChangePlan[] = [];
  private targetIndex = 0;
  private modeIndex = 0;
  private stackIndex = 0;
  private selectionIndex = 0;
  private approvalIndex = 0;
  constructor(private readonly script: ScriptedInteractionScript = {}) {}

  async chooseTarget(initial?: string): Promise<string> {
    return this.script.targets?.[this.targetIndex++] ?? initial ?? ".";
  }
  async resolveStack(conflicts: readonly StackConflict[]): Promise<ConfirmedStack> {
    void conflicts;
    const stack = this.script.stacks?.[this.stackIndex++];
    if (stack === undefined) throw new Error("No scripted confirmed stack");
    return stack;
  }
  async chooseMode(initial?: string): Promise<"auto" | "manual"> {
    return this.script.modes?.[this.modeIndex++] ?? (initial === "manual" ? "manual" : "auto");
  }
  async selectComponents(view: ComponentSelectionView): Promise<readonly ComponentId[]> {
    void view;
    return this.script.selections?.[this.selectionIndex++] ?? [];
  }
  async reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions> {
    this.plans.push(plan);
    const approval = this.script.approvals?.[this.approvalIndex++];
    if (approval === undefined) throw new Error("No scripted approval");
    return approval;
  }
  render(event: RedactedEvent): void { this.events.push(event); }
}
