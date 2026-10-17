export type SkillScope = "project" | "global";

export interface LocalSkillsOptions {
  readonly projectRoot?: string;
  readonly homeDir: string;
  readonly globalStateRoot?: string;
  readonly allowMutations: boolean;
}

/** Unknown lock fields are retained when updating official CLI metadata. */
export interface InstalledSkillEntry extends Record<string, unknown> {
  source: string;
  sourceType: string;
  skillPath?: string;
  ref?: string;
  computedHash?: string;
  skillFolderHash?: string;
}

export interface SkillFile {
  path: string;
  sha: string;
  size?: number;
  mode: string;
}

export interface SkillSnapshot {
  folderHash: string;
  files: SkillFile[];
}

export interface ResolvedSkill {
  entry: InstalledSkillEntry;
  snapshot: SkillSnapshot;
}

/** Immutable GitHub objects are the external I/O seam; no skill code is executed. */
export interface SkillSource {
  latest(entry: InstalledSkillEntry, signal?: AbortSignal): Promise<SkillSnapshot>;
  baseline(entry: InstalledSkillEntry, signal?: AbortSignal): Promise<SkillSnapshot>;
  readFile(entry: InstalledSkillEntry, file: SkillFile, signal?: AbortSignal): Promise<Buffer>;
  /** Locate one skill folder in a repository's default-branch tree (install only). */
  resolve?(source: string, skill: string, folder: string | undefined, signal?: AbortSignal): Promise<ResolvedSkill>;
}

export interface ListInstalledInput {
  scope: SkillScope;
  limit?: number;
  offset?: number;
}

export interface CheckUpdatesInput extends ListInstalledInput {
  name?: string;
}

export interface SkillMutationInput {
  scope: SkillScope;
  name: string;
  dry_run?: boolean;
  confirm?: boolean;
  confirmation_token?: string;
}

export interface InstallSkillInput {
  /** skills.sh skill id: `{owner}/{repo}/{skill}`; well-known domains are unsupported. */
  id: string;
  /** Optional repo-relative skill folder (e.g. `skills/my-skill`) used to disambiguate. */
  path?: string;
  scope: SkillScope;
  dry_run?: boolean;
  confirm?: boolean;
  confirmation_token?: string;
}
