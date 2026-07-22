import type {
  AutoSkillsGateway,
  ExternalOperationApproval,
  FileSystemPort,
  InstalledArtifact,
  ProcessExecutor,
  SkillOwnershipStore,
} from "../../domain/index.js";
import type { CatalogSnapshot, SkillCatalogEntry } from "../../domain/catalog/models.js";
import { AUTOSKILLS_SOURCE_REPOSITORY, catalogError, registerAutoSkillsInteractive } from "../../domain/catalog/autoskills.js";
import type { CanonicalPath, InstallationError, Result, RunId } from "../../domain/shared/types.js";
import { err, ok } from "../../domain/shared/types.js";

export interface AutoSkillsGatewayOptions {
  readonly root: CanonicalPath;
  readonly authorizeListing?: () => boolean | Promise<boolean>;
  /** Retained for composition compatibility; autoskills owns its TUI effects. */
  readonly maxOutputBytes?: number;
  readonly fileSystem?: FileSystemPort;
  readonly ownershipStore?: SkillOwnershipStore;
  readonly ownershipRunId?: RunId;
}

const failed = (message: string, cause?: string): Result<never, import("../../domain/shared/types.js").CatalogError> =>
  err(catalogError("CATALOG_EXECUTION_FAILED", message, cause));
const unsupportedInstallation = (): Result<never, InstallationError> =>
  err({
    code: "INSTALLATION_FAILED",
    message: "autoskills no expone instalación individual; selecciona Skills en su TUI oficial",
    recoverability: "none",
  });

/** Adapter for the published midudev autoskills CLI. Its only supported API is the interactive TUI. */
export class MidudevAutoSkillsGateway implements AutoSkillsGateway {
  public readonly root: CanonicalPath;
  private readonly authorizeListing: () => boolean | Promise<boolean>;

  public constructor(
    private readonly executor: ProcessExecutor,
    options: AutoSkillsGatewayOptions,
  ) {
    this.root = options.root;
    this.authorizeListing = options.authorizeListing ?? (() => false);
  }

  public async runInteractive(): Promise<Result<void, import("../../domain/shared/types.js").CatalogError>> {
    if (!(await this.authorizeListing())) return failed("autoskills no fue autorizado por el usuario", "authorization denied");
    const request = registerAutoSkillsInteractive(this.root, true);
    if (!request.ok) return request;
    try {
      const result = await this.executor.execute(request.value);
      if (result.timedOut || result.truncated || result.exitCode !== 0)
        return failed("npx autoskills no finalizó correctamente", result.timedOut ? "process timed out" : result.stderr.slice(0, 512));
      return ok(undefined);
    } catch (error) {
      return failed("No se pudo ejecutar npx autoskills", error instanceof Error ? error.message : String(error));
    }
  }

  /** The published CLI has no `list --json`; this method never starts a process. */
  public async list(): Promise<Result<CatalogSnapshot, import("../../domain/shared/types.js").CatalogError>> {
    return failed("autoskills no ofrece un catálogo estructurado", "Comando soportado: npx autoskills");
  }

  /** The published CLI has no `install <id>`; installation belongs to the TUI. */
  public async install(
    _entry: SkillCatalogEntry,
    _approval: ExternalOperationApproval,
    _target: import("../../domain/shared/types.js").SafeProjectPath,
    _presentedSnapshot?: CatalogSnapshot,
  ): Promise<Result<InstalledArtifact, InstallationError>> {
    void _entry;
    void _approval;
    void _target;
    void _presentedSnapshot;
    return unsupportedInstallation();
  }
}

export const createMidudevAutoSkillsGateway = (executor: ProcessExecutor, options: AutoSkillsGatewayOptions): MidudevAutoSkillsGateway =>
  new MidudevAutoSkillsGateway(executor, options);

export { AUTOSKILLS_SOURCE_REPOSITORY };
