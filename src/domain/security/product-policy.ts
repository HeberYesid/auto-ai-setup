import { AUTOSKILLS_SOURCE_REPOSITORY } from "../catalog/autoskills.js";
import type { ExternalOperation } from "../planning/models.js";
import { isSafeRelativePath } from "../shared/types.js";

/** The only process shape that can be delegated to the official autoskills TUI. */
export const OFFICIAL_AUTOSKILLS_COMMAND = ["npx", "--yes", "autoskills"] as const;

const forbiddenArgumentPattern = /[\0\r\n;&|`$<>]/;
const forbiddenSubcommandPattern = /^(?:install|list|download|fetch|add|remove|update|--json)$/i;

/**
 * Checks the command metadata without executing it. Extra arguments are retained as
 * descriptive metadata for compatibility, but shell syntax and direct catalog/download
 * subcommands are never accepted as an autoskills operation.
 */
export const isOfficialAutoSkillsCommand = (command: readonly string[]): boolean =>
  command.length >= OFFICIAL_AUTOSKILLS_COMMAND.length &&
  OFFICIAL_AUTOSKILLS_COMMAND.every((part, index) => command[index] === part) &&
  command.every((argument, index) => {
    if (typeof argument !== "string" || argument.length === 0 || forbiddenArgumentPattern.test(argument)) return false;
    return index < OFFICIAL_AUTOSKILLS_COMMAND.length || !forbiddenSubcommandPattern.test(argument);
  });

/**
 * Product boundary for external plan entries. Recommended CLIs, MCP servers, arbitrary
 * shell commands, lifecycle scripts, telemetry, and direct Skill downloads all fail this
 * predicate before they can enter a ChangePlan.
 */
export const isAllowedAutoSkillsOperation = (operation: ExternalOperation): boolean =>
  operation.kind === "skill-install" &&
  operation.usesNetwork === true &&
  operation.origin === AUTOSKILLS_SOURCE_REPOSITORY &&
  isOfficialAutoSkillsCommand(operation.command) &&
  operation.destination.length > 0 &&
  isSafeRelativePath(String(operation.destination)) &&
  operation.purpose.trim().length > 0 &&
  operation.expectedFiles.every(
    (file) =>
      file.path.length > 0 &&
      isSafeRelativePath(file.path) &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      typeof file.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256),
  );

export const autoSkillsPolicyFailure = (operation: Pick<ExternalOperation, "id">): string =>
  `External operation ${operation.id} is not an approved official npx autoskills operation`;

/** A process request is intentionally narrower than plan metadata: only the interactive TUI. */
export const isApprovedAutoSkillsInteractiveRequest = (request: {
  readonly command: string;
  readonly operation: string;
  readonly args: readonly string[];
  readonly authorized: boolean;
}): boolean =>
  request.command === "npx-autoskills" &&
  request.operation === "interactive" &&
  request.authorized === true &&
  request.args.length === 0;
