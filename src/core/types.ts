import * as vscode from 'vscode';

export type StagingMode = 'changelist' | 'index';

export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';

export interface GitFileChange {
	readonly repoRoot: string;
	readonly relativePath: string;
	readonly originalRelativePath?: string;
	readonly uri: vscode.Uri;
	readonly indexStatus: FileStatusCode | '.';
	readonly workTreeStatus: FileStatusCode | '.';
	readonly isConflicted: boolean;
	readonly isUntracked: boolean;
	readonly isStaged: boolean;
	readonly isModifiedInWorkTree: boolean;
}

export interface Changelist {
	readonly id: string;
	name: string;
	comment: string;
	isActive: boolean;
	readonly isDefault: boolean;
	/** Relative file paths (normalized with forward slashes) assigned to this changelist */
	files: string[];
}

export interface GitRepositoryRoot {
	readonly rootPath: string;
	readonly rootUri: vscode.Uri;
	readonly name: string;
	readonly isExplicitMapping: boolean;
	readonly isSubmodule: boolean;
	currentBranch: string;
	upstreamBranch?: string;
	ahead: number;
	behind: number;
	isDetachedHead: boolean;
}

export interface SubmoduleInfo {
	readonly name: string;
	readonly relativePath: string;
	readonly fullPath: string;
	readonly sha: string;
	readonly branchOrTag: string;
	readonly isDetached: boolean;
	readonly isUninitialized: boolean;
}

export interface WorktreeInfo {
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly headSha: string;
	readonly branch: string;
	readonly isBare: boolean;
	readonly isMain: boolean;
	readonly isDetached: boolean;
}

export interface GitRemoteInfo {
	readonly name: string;
	readonly fetchUrl: string;
	readonly pushUrl: string;
}

export interface GitBranchInfo {
	readonly name: string;
	readonly isCurrent: boolean;
	readonly isRemote: boolean;
	readonly remoteName?: string;
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	readonly lastCommitHash: string;
	readonly lastCommitSubject: string;
	readonly isProtected: boolean;
}

export interface CommitOptions {
	readonly message: string;
	readonly amend: boolean;
	readonly signOff: boolean;
	readonly gpgSign: boolean;
	readonly author?: string;
	readonly runGitHooks: boolean;
	readonly reformatCode: boolean;
	readonly optimizeImports: boolean;
	readonly analyzeCode: boolean;
	readonly checkTodo: boolean;
	readonly pushAfterCommit?: boolean;
}

export interface QualityGateResult {
	readonly passed: boolean;
	readonly errors: string[];
	readonly warnings: string[];
	readonly todoItems: { file: string; line: number; text: string }[];
}

export interface GitCommitLogEntry {
	readonly hash: string;
	readonly shortHash: string;
	readonly parents: string[];
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDateIso: string;
	readonly committerDateIso: string;
	readonly subject: string;
	readonly refs: string[];
	/** Computed swimlane column index for DAG rendering */
	lane?: number;
	/** Computed color index for swimlane rendering */
	colorIndex?: number;
}

export interface GitLogFilter {
	branch?: string;
	user?: string;
	dateRange?: 'all' | 'today' | '7days' | '30days' | string;
	pathFilter?: string;
	searchPattern?: string;
	isRegex?: boolean;
	maxCount?: number;
}

export interface CommitFileDelta {
	readonly status: string;
	readonly relativePath: string;
	readonly oldRelativePath?: string;
}

export interface ConflictStages {
	readonly repoRoot: string;
	readonly relativePath: string;
	readonly baseContent: string;
	readonly yoursContent: string;
	readonly theirsContent: string;
	readonly workingCopyContent: string;
}

export interface Diff3Region {
	readonly id: number;
	readonly type: 'clean' | 'conflict';
	readonly changeSource?: 'unchanged' | 'yours' | 'theirs' | 'both-identical';
	readonly baseLines: string[];
	readonly yoursLines: string[];
	readonly theirsLines: string[];
	resolvedLines: string[];
	isResolved: boolean;
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface InteractiveRebaseEntry {
	readonly hash: string;
	readonly shortHash: string;
	readonly author: string;
	readonly dateIso: string;
	subject: string;
	action: RebaseAction;
}

export interface ShelfEntry {
	readonly id: string;
	readonly name: string;
	readonly createdAtIso: string;
	readonly repoRoot: string;
	readonly baseCommitSha: string;
	readonly patchFilePath: string;
	readonly files: string[];
}

export interface StashEntry {
	readonly index: number;
	readonly ref: string;
	readonly branch: string;
	readonly message: string;
	readonly repoRoot: string;
}

export interface BlameLineInfo {
	readonly lineNumber: number;
	readonly hash: string;
	readonly shortHash: string;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorTimestampSec: number;
	readonly summary: string;
}

export interface GitCommandLogEntry {
	readonly timestampIso: string;
	readonly repoRoot: string;
	readonly command: string;
	readonly durationMs: number;
	readonly exitCode: number;
	readonly stdoutPreview: string;
	readonly stderrPreview: string;
}
