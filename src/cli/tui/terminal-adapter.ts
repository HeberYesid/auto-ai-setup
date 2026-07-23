/**
 * Node terminal capability and input adapter for the modern TUI.
 *
 * This adapter is the substitutable {@link TerminalPort} implementation at the CLI boundary. It
 * probes both TTY streams, ANSI/color/Unicode/dimensions/mouse and `NO_COLOR` before any output;
 * normalizes platform input into the domain's closed {@link UiEvent} variants; subscribes to resize;
 * enters raw input mode only when asked for an eligible interactive profile; and restores terminal
 * state (input mode, cursor visibility, mouse reporting, and pending cleanups) idempotently on
 * completion, cancellation, interruption, and controlled failure.
 *
 * It never exposes raw escape sequences to reducers and never emits control sequences the detected
 * terminal does not support: ANSI-bearing operations are gated on detected ANSI capability, and
 * mouse events are emitted only when mouse support is known.
 *
 * Construction reads `process` streams/env only through {@link createNodeTerminalAdapter}, keeping
 * the class itself driven by injected, testable structural dependencies.
 */

import process from "node:process";

import type {
  TerminalError,
  TerminalErrorCode,
  TerminalEventListener,
  TerminalPort,
  Unsubscribe,
} from "../../application/session/effect-ports.js";
import { isKnown, type PresentationMode, type TerminalCapabilities, type UiEvent } from "../../domain/tui/index.js";
import { err, ok, type Result } from "../../domain/shared/types.js";

import { noAnimationFlagFromArgs, resolveNoAnimation } from "./animation-preference.js";
import { probeCapabilities, type EnvLookup } from "./capability-probe.js";
import { chunkToText, decodeInputChunk, type DecodedInput } from "./input-normalizer.js";

/** Minimal structural view of a terminal input stream (satisfied by `process.stdin`). */
export interface TerminalInputStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  resume?(): void;
  pause?(): void;
  setEncoding?(encoding: string): void;
}

/** Minimal structural view of a terminal output stream (satisfied by `process.stdout`). */
export interface TerminalOutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(data: string): boolean;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

/** Minimal structural view of a process-signal source (satisfied by `process`). */
export interface SignalSource {
  on(signal: "SIGINT", listener: () => void): void;
  off(signal: "SIGINT", listener: () => void): void;
}

/** The injected platform dependencies the adapter operates on. */
export interface NodeTerminalStreams {
  readonly input: TerminalInputStream;
  readonly output: TerminalOutputStream;
  readonly signals: SignalSource;
  readonly env: EnvLookup;
  readonly argv: readonly string[];
  readonly platform: string;
}

/** Optional adapter behavior hooks. */
export interface NodeTerminalAdapterOptions {
  /**
   * Resolves a decoded mouse click (1-based terminal coordinates) to an interactive control id using
   * the current layout. Returning `undefined` ignores the click (empty space or a disabled control),
   * leaving state unchanged. Mouse events are never emitted without this resolver.
   */
  readonly resolveMouseTarget?: (coords: { readonly column: number; readonly row: number }) => string | undefined;
}

const SHOW_CURSOR = "\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1000l\u001b[?1006l";

const terminalError = (code: TerminalErrorCode, message: string, cause?: unknown): TerminalError => ({
  code,
  message,
  recoverability: "none",
  ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
});

/**
 * Substitutable Node terminal adapter. All effectful methods return typed {@link Result}s so an
 * unavailable resource fails closed with a classified error instead of throwing.
 */
export class NodeTerminalAdapter implements TerminalPort {
  private capabilities: TerminalCapabilities | undefined;
  private rawMode = false;
  private mouseReportingEnabled = false;
  private cursorHidden = false;
  private restored = false;
  private dataHandler: ((chunk: Buffer | string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  private sigintHandler: (() => void) | undefined;
  private readonly cleanups: Array<() => void> = [];

  public constructor(
    private readonly streams: NodeTerminalStreams,
    private readonly options: NodeTerminalAdapterOptions = {},
  ) {}

  /** Probe capabilities before any output. Caches the snapshot for later ANSI/mouse gating. */
  public probeCapabilities(): Result<TerminalCapabilities, TerminalError> {
    try {
      const capabilities = probeCapabilities({
        inputIsTty: this.streams.input.isTTY === true,
        outputIsTty: this.streams.output.isTTY === true,
        columns: this.streams.output.columns,
        rows: this.streams.output.rows,
        env: this.streams.env,
        platform: this.streams.platform,
      });
      this.capabilities = capabilities;
      return ok(capabilities);
    } catch (cause) {
      return err(terminalError("CAPABILITY_PROBE_FAILED", "Failed to probe terminal capabilities", cause));
    }
  }

  /** Subscribe to normalized key/mouse/resize events plus interruption. Fails closed on wiring errors. */
  public subscribe(listener: TerminalEventListener): Result<Unsubscribe, TerminalError> {
    try {
      this.restored = false;
      this.streams.input.setEncoding?.("utf8");

      const dataHandler = (chunk: Buffer | string): void => {
        for (const decoded of decodeInputChunk(chunkToText(chunk))) {
          this.emitDecoded(listener, decoded);
        }
      };
      const resizeHandler = (): void => {
        const probe = this.probeCapabilities();
        if (probe.ok) listener({ kind: "resize", capabilities: probe.value });
      };
      // SIGINT is surfaced as the normalized cancellation-request key rather than terminating the
      // process, so the reducer can route it to cancellation or the transaction lifecycle.
      const sigintHandler = (): void => listener({ kind: "key", key: { kind: "named", name: "Escape" } });

      this.streams.input.on("data", dataHandler);
      this.streams.output.on("resize", resizeHandler);
      this.streams.signals.on("SIGINT", sigintHandler);
      this.streams.input.resume?.();

      this.dataHandler = dataHandler;
      this.resizeHandler = resizeHandler;
      this.sigintHandler = sigintHandler;

      return ok(() => this.teardownSubscription());
    } catch (cause) {
      return err(terminalError("TERMINAL_UNAVAILABLE", "Failed to subscribe to terminal input", cause));
    }
  }

  /** Write already-rendered output. ANSI policy for content is enforced by the output adapter. */
  public write(output: string): Result<void, TerminalError> {
    try {
      this.streams.output.write(output);
      return ok(undefined);
    } catch (cause) {
      return err(terminalError("WRITE_FAILED", "Failed to write terminal output", cause));
    }
  }

  /** Enter raw input mode. Permitted only for an interactive TTY input; fails closed otherwise. */
  public enterRawMode(): Result<void, TerminalError> {
    if (this.streams.input.isTTY !== true || this.streams.input.setRawMode === undefined) {
      return err(terminalError("RAW_MODE_FAILED", "Raw mode requires an interactive TTY input stream"));
    }
    try {
      this.streams.input.setRawMode(true);
      this.rawMode = true;
      return ok(undefined);
    } catch (cause) {
      return err(terminalError("RAW_MODE_FAILED", "Failed to enter raw input mode", cause));
    }
  }

  /**
   * Enable mouse reporting. No-op (emitting nothing) unless the terminal supports both ANSI and
   * mouse, so unsupported control sequences are never written.
   */
  public enableMouseReporting(): Result<void, TerminalError> {
    if (!this.ansiAllowed() || !this.mouseSupported()) return ok(undefined);
    try {
      this.streams.output.write(ENABLE_MOUSE);
      this.mouseReportingEnabled = true;
      return ok(undefined);
    } catch (cause) {
      return err(terminalError("WRITE_FAILED", "Failed to enable mouse reporting", cause));
    }
  }

  /** Hide the cursor. No-op unless ANSI is supported, so no unsupported sequence is emitted. */
  public hideCursor(): Result<void, TerminalError> {
    if (!this.ansiAllowed()) return ok(undefined);
    try {
      this.streams.output.write(HIDE_CURSOR);
      this.cursorHidden = true;
      return ok(undefined);
    } catch (cause) {
      return err(terminalError("WRITE_FAILED", "Failed to hide cursor", cause));
    }
  }

  /** Register an additional cleanup (for example a pending-timer canceller) run idempotently on restore. */
  public registerCleanup(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  /**
   * Restore terminal state idempotently: run registered cleanups, disable mouse reporting, show the
   * cursor, leave raw mode, and detach all listeners. Safe to call repeatedly and from finally/abort
   * paths on completion, cancellation, interruption, and controlled failure.
   */
  public restore(): Result<void, TerminalError> {
    if (this.restored) return ok(undefined);
    this.restored = true;

    const failures: string[] = [];
    const attempt = (action: () => void): void => {
      try {
        action();
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }
    };

    for (const cleanup of this.cleanups.splice(0)) attempt(cleanup);

    if (this.mouseReportingEnabled) {
      attempt(() => this.streams.output.write(DISABLE_MOUSE));
      this.mouseReportingEnabled = false;
    }
    if (this.cursorHidden) {
      attempt(() => this.streams.output.write(SHOW_CURSOR));
      this.cursorHidden = false;
    }
    if (this.rawMode && this.streams.input.setRawMode !== undefined) {
      const setRawMode = this.streams.input.setRawMode.bind(this.streams.input);
      attempt(() => setRawMode(false));
      this.rawMode = false;
    }

    this.teardownSubscription();

    return failures.length === 0 ? ok(undefined) : err(terminalError("RESTORE_FAILED", failures.join("; ")));
  }

  /**
   * Resolve whether animation must be suppressed for a given mode, honoring the documented precedence
   * (`--no-animation` flag > `AUTO_AI_SETUP_NO_ANIMATION` env > in-session toggle) and forcing
   * suppression in linear-text/non-interactive modes or when `NO_COLOR` is active.
   */
  public noAnimationPreference(mode: PresentationMode, sessionToggle = false): boolean {
    return resolveNoAnimation({
      noAnimationFlag: noAnimationFlagFromArgs(this.streams.argv),
      envValue: this.streams.env("AUTO_AI_SETUP_NO_ANIMATION"),
      sessionToggle,
      mode,
      noColor: this.capabilities?.noColor ?? false,
    });
  }

  private emitDecoded(listener: TerminalEventListener, decoded: DecodedInput): void {
    switch (decoded.kind) {
      case "key": {
        const event: UiEvent = { kind: "key", key: decoded.key };
        listener(event);
        return;
      }
      case "interrupt": {
        // Ctrl+C in raw mode: same normalized cancellation-request as a SIGINT signal.
        listener({ kind: "key", key: { kind: "named", name: "Escape" } });
        return;
      }
      case "mouse": {
        if (!this.mouseSupported() || decoded.release || decoded.button !== 0) return;
        const controlId = this.options.resolveMouseTarget?.({ column: decoded.column, row: decoded.row });
        if (controlId === undefined) return;
        listener({ kind: "mouse", action: "activate", controlId });
        return;
      }
    }
  }

  private teardownSubscription(): void {
    if (this.dataHandler !== undefined) {
      this.streams.input.off("data", this.dataHandler);
      this.dataHandler = undefined;
    }
    if (this.resizeHandler !== undefined) {
      this.streams.output.off("resize", this.resizeHandler);
      this.resizeHandler = undefined;
    }
    if (this.sigintHandler !== undefined) {
      this.streams.signals.off("SIGINT", this.sigintHandler);
      this.sigintHandler = undefined;
    }
  }

  private ansiAllowed(): boolean {
    const capabilities = this.capabilities;
    return (
      capabilities !== undefined &&
      isKnown(capabilities.outputTty) &&
      capabilities.outputTty.value &&
      isKnown(capabilities.ansiCursor) &&
      capabilities.ansiCursor.value
    );
  }

  private mouseSupported(): boolean {
    const capabilities = this.capabilities;
    return capabilities !== undefined && isKnown(capabilities.mouse) && capabilities.mouse.value;
  }
}

const wrapInput = (stream: NodeJS.ReadStream): TerminalInputStream => {
  const base: TerminalInputStream = {
    isTTY: stream.isTTY === true,
    on: (event, listener) => {
      stream.on(event, listener);
    },
    off: (event, listener) => {
      stream.off(event, listener);
    },
    resume: () => {
      stream.resume();
    },
    pause: () => {
      stream.pause();
    },
    setEncoding: (encoding) => {
      stream.setEncoding(encoding as BufferEncoding);
    },
  };
  if (stream.isTTY === true && typeof stream.setRawMode === "function") {
    return {
      ...base,
      setRawMode: (mode) => {
        stream.setRawMode(mode);
      },
    };
  }
  return base;
};

const wrapOutput = (stream: NodeJS.WriteStream): TerminalOutputStream => ({
  isTTY: stream.isTTY === true,
  ...(typeof stream.columns === "number" ? { columns: stream.columns } : {}),
  ...(typeof stream.rows === "number" ? { rows: stream.rows } : {}),
  write: (data) => stream.write(data),
  on: (event, listener) => {
    stream.on(event, listener);
  },
  off: (event, listener) => {
    stream.off(event, listener);
  },
});

const nodeSignals: SignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
};

/**
 * Construct a {@link NodeTerminalAdapter} bound to the real Node process streams, environment, and
 * signals. This is the single construction boundary where `process` is touched; the adapter itself
 * remains driven by injected structural dependencies for deterministic testing.
 */
export const createNodeTerminalAdapter = (options: NodeTerminalAdapterOptions = {}): NodeTerminalAdapter =>
  new NodeTerminalAdapter(
    {
      input: wrapInput(process.stdin),
      output: wrapOutput(process.stdout),
      signals: nodeSignals,
      env: (name) => process.env[name],
      argv: process.argv.slice(2),
      platform: process.platform,
    },
    options,
  );
