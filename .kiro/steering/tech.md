# Technology and Engineering Rules

## Stack
- TypeScript in strict mode, compiled to `dist/`.
- Node.js 20+ runtime; publish as an ESM npm package with a portable shebang and `package.json#bin`.
- Vitest for unit/integration tests and fast-check for property-based tests.
- JSON is the only structured configuration format written by the MVP.

## Architecture and style
- Use hexagonal/layered architecture: `cli` -> `application` -> pure `domain`; infrastructure implements ports.
- Keep domain logic deterministic and free of terminal, filesystem, process, network, and environment APIs.
- Use dependency injection through typed ports/adapters. Prefer pure functions for detection, compatibility, planning, redaction, and configuration merging.
- Use discriminated unions and typed `Result` errors at domain boundaries; avoid unclassified exceptions.
- Preserve unknown configuration fields, formatting where practical, unrelated array order, and user-owned content.
- Use stable ordering, canonical serialization, SHA-256 plan hashes, semantic diffs, and idempotent operations.
- Validate lexical and real filesystem containment; reject traversal, absolute/device/NUL paths, and symlink escapes.
- Apply approved changes transactionally with staging, fsync/atomic rename, backups, persistent journals, verification, rollback, and recovery.
- Redact secrets before any terminal or file sink. Network is deny-by-default and process execution is allowlisted.
-USE PNPM instead of npm


Use the actual package scripts as the source of truth once they exist. Tests must be deterministic, use injected fakes for I/O/process/network, and avoid public-network dependencies.
