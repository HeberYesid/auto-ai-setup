import type { FileSystemPort } from "../../domain/index.js";
import { FileSystemSkillOwnershipStore } from "./skill-ownership.js";

/** Generic name for the state store; the legacy Skill name remains supported. */
export class FileSystemManagedStateStore extends FileSystemSkillOwnershipStore {
  public constructor(fileSystem: FileSystemPort) {
    super(fileSystem);
  }
}

export const createFileSystemManagedStateStore = (fileSystem: FileSystemPort): FileSystemManagedStateStore =>
  new FileSystemManagedStateStore(fileSystem);
