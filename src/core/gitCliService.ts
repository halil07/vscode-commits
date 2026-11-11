import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
	BlameLineInfo,
	CommitFileDelta,
	CommitOptions,
	ConflictStages,
	FileStatusCode,
	GitBranchInfo,
	GitCommandLogEntry,
	GitCommitLogEntry,
	GitFileChange,
	GitLogFilter,
	GitRemoteInfo,
	StashEntry,
	SubmoduleInfo,
	WorktreeInfo
} from './types';

export interface GitExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * Low-level Git CLI Execution Engine.
 * Encapsulates all Git subprocess invocations with structured parsing,
 * console logging, and error safety.
 */
export class GitCliService implements vscode.Disposable {
	private readonly outputChannel: vscode.OutputChannel;
	private readonly commandHistory: GitCommandLogEntry[] = [];
	private readonly _onDidRunGitCommand = new vscode.EventEmitter<GitCommandLogEntry>();
	public readonly onDidRunGitCommand = this._onDidRunGitCommand.event;

	constructor() {
		this.outputChannel = vscode.window.createOutputChannel('CommitPro Console');
	}

	public getCommandHistory(): readonly GitCommandLogEntry[] {
		return this.commandHistory;
	}

	public showConsole(): void {
		this.outputChannel.show(true);
	}

	public async execGit(
		repoRoot: string,
		args: string[],
		options?: { stdin?: string; env?: NodeJS.ProcessEnv; allowNonZeroExit?: boolean }
	): Promise<GitExecResult> {
		const startTime = Date.now();
		const commandDisplay = `git ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

		return new Promise<GitExecResult>((resolve, reject) => {
			const child = execFile(
				'git',
				args,
				{
					cwd: repoRoot,
					maxBuffer: 25 * 1024 * 1024,
					env: {
						...process.env,
						GIT_TERMINAL_PROMPT: '0',
						LC_ALL: 'C.UTF-8',
						...(options?.env ?? {})
					}
				},
				(error, stdout, stderr) => {
					const durationMs = Date.now() - startTime;
					const exitCode = error && typeof (error as { code?: number }).code === 'number'
						? (error as { code: number }).code
						: error ? 1 : 0;

					const entry: GitCommandLogEntry = {
						timestampIso: new Date().toISOString(),
						repoRoot,
						command: commandDisplay,
						durationMs,
						exitCode,
						stdoutPreview: stdout.slice(0, 800),
						stderrPreview: stderr.slice(0, 800)
					};

					this.recordCommandLog(entry);

					if (exitCode !== 0 && !options?.allowNonZeroExit) {
						reject(new Error(`Git command failed (${commandDisplay}): ${stderr.trim() || error?.message || 'Unknown error'}`));
						return;
					}

					resolve({ stdout, stderr, exitCode });
				}
			);

			if (options?.stdin !== undefined && child.stdin) {
				child.stdin.write(options.stdin);
				child.stdin.end();
			}
		});
	}

	private recordCommandLog(entry: GitCommandLogEntry): void {
		this.commandHistory.unshift(entry);
		if (this.commandHistory.length > 200) {
			this.commandHistory.pop();
		}
		this.outputChannel.appendLine(
			`[${entry.timestampIso}] (${path.basename(entry.repoRoot)}) ${entry.command} [${entry.durationMs}ms, exit=${entry.exitCode}]`
		);
		if (entry.stderrPreview.trim()) {
			this.outputChannel.appendLine(`  stderr: ${entry.stderrPreview.trim()}`);
		}
		this._onDidRunGitCommand.fire(entry);
	}

	// =========================================================================
	// Repository Setup & Status (Porcelain v2)
	// =========================================================================

	public async initRepository(targetDir: string): Promise<void> {
		await this.execGit(targetDir, ['init']);
	}

	public async getRepositoryStatus(repoRoot: string): Promise<{
		branch: string;
		upstream?: string;
		ahead: number;
		behind: number;
		isDetached: boolean;
		changes: GitFileChange[];
	}> {
		const { stdout } = await this.execGit(repoRoot, [
			'status',
			'--porcelain=v2',
			'--branch',
			'--untracked-files=all'
		]);

		let branch = 'HEAD';
		let upstream: string | undefined;
		let ahead = 0;
		let behind = 0;
		let isDetached = false;
		const changes: GitFileChange[] = [];

		const lines = stdout.split(/\r?\n/);
		for (const line of lines) {
			if (!line) {
				continue;
			}
			if (line.startsWith('# branch.head ')) {
				const headVal = line.slice('# branch.head '.length).trim();
				if (headVal === '(detached)') {
					isDetached = true;
					branch = 'HEAD (detached)';
				} else {
					branch = headVal;
				}
			} else if (line.startsWith('# branch.upstream ')) {
				upstream = line.slice('# branch.upstream '.length).trim();
			} else if (line.startsWith('# branch.ab ')) {
				const parts = line.slice('# branch.ab '.length).trim().split(' ');
				for (const part of parts) {
					if (part.startsWith('+')) {
						ahead = parseInt(part.slice(1), 10) || 0;
					} else if (part.startsWith('-')) {
						behind = parseInt(part.slice(1), 10) || 0;
					}
				}
			} else if (line.startsWith('1 ') || line.startsWith('2 ')) {
				const isRename = line.startsWith('2 ');
				const fields = line.split(' ');
				const xy = fields[1];
				const indexStatus = (xy[0] || '.') as FileStatusCode | '.';
				const workTreeStatus = (xy[1] || '.') as FileStatusCode | '.';

				let relativePath: string;
				let originalRelativePath: string | undefined;
				if (isRename) {
					const tabParts = line.split('\t');
					const firstSegmentFields = tabParts[0].split(' ');
					relativePath = firstSegmentFields.slice(9).join(' ');
					originalRelativePath = tabParts[1];
				} else {
					relativePath = fields.slice(8).join(' ');
				}

				const normalizedRelPath = relativePath.replace(/\\/g, '/');
				const uri = vscode.Uri.file(path.join(repoRoot, normalizedRelPath));
				changes.push({
					repoRoot,
					relativePath: normalizedRelPath,
					originalRelativePath: originalRelativePath?.replace(/\\/g, '/'),
					uri,
					indexStatus,
					workTreeStatus,
					isConflicted: false,
					isUntracked: false,
					isStaged: indexStatus !== '.',
					isModifiedInWorkTree: workTreeStatus !== '.'
				});
			} else if (line.startsWith('u ')) {
				const fields = line.split(' ');
				const relativePath = fields.slice(10).join(' ').replace(/\\/g, '/');
				const uri = vscode.Uri.file(path.join(repoRoot, relativePath));
				changes.push({
					repoRoot,
					relativePath,
					uri,
					indexStatus: 'U',
					workTreeStatus: 'U',
					isConflicted: true,
					isUntracked: false,
					isStaged: false,
					isModifiedInWorkTree: true
				});
			} else if (line.startsWith('? ')) {
				const relativePath = line.slice(2).trim().replace(/\\/g, '/');
				const uri = vscode.Uri.file(path.join(repoRoot, relativePath));
				changes.push({
					repoRoot,
					relativePath,
					uri,
					indexStatus: '?',
					workTreeStatus: '?',
					isConflicted: false,
					isUntracked: true,
					isStaged: false,
					isModifiedInWorkTree: true
				});
			}
		}

		return { branch, upstream, ahead, behind, isDetached, changes };
	}

	// =========================================================================
	// Staging, Partial Patching, Rollback & Commit
	// =========================================================================

	public async stageFiles(repoRoot: string, relativePaths: string[]): Promise<void> {
		if (relativePaths.length === 0) {
			return;
		}
		await this.execGit(repoRoot, ['add', '--', ...relativePaths]);
	}

	public async unstageFiles(repoRoot: string, relativePaths: string[]): Promise<void> {
		if (relativePaths.length === 0) {
			return;
		}
		await this.execGit(repoRoot, ['restore', '--staged', '--', ...relativePaths], { allowNonZeroExit: true });
	}

	public async discardFileChanges(repoRoot: string, relativePaths: string[], untrackedPaths: string[]): Promise<void> {
		if (relativePaths.length > 0) {
			await this.execGit(repoRoot, ['checkout', 'HEAD', '--', ...relativePaths]);
		}
		for (const untracked of untrackedPaths) {
			const fullPath = path.join(repoRoot, untracked);
			await fs.rm(fullPath, { force: true, recursive: true });
		}
	}

	public async applyPatchToIndex(repoRoot: string, patchContent: string): Promise<void> {
		await this.execGit(repoRoot, ['apply', '--cached', '--unidiff-zero', '-'], { stdin: patchContent });
	}

	public async commit(repoRoot: string, options: CommitOptions, specificFiles?: string[]): Promise<string> {
		if (specificFiles && specificFiles.length > 0) {
			await this.execGit(repoRoot, ['add', '--', ...specificFiles]);
		}

		const args: string[] = ['commit', '-m', options.message];
		if (options.amend) {
			args.push('--amend');
		}
		if (options.signOff) {
			args.push('--signoff');
		}
		if (options.gpgSign) {
			args.push('-S');
		}
		if (options.author && options.author.trim().length > 0) {
			args.push(`--author=${options.author.trim()}`);
		}
		if (!options.runGitHooks) {
			args.push('--no-verify');
		}
		if (specificFiles && specificFiles.length > 0) {
			args.push('--only', '--', ...specificFiles);
		}

		const { stdout } = await this.execGit(repoRoot, args);
		return stdout;
	}

	public async undoLastCommit(repoRoot: string): Promise<void> {
		await this.execGit(repoRoot, ['reset', '--soft', 'HEAD~1']);
	}

	public async getLastCommitMessage(repoRoot: string): Promise<string> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['log', '-1', '--pretty=%B'], { allowNonZeroExit: true });
		return exitCode === 0 ? stdout.trim() : '';
	}

	public async getCommitMessage(repoRoot: string, commitHash: string): Promise<string> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['log', '-1', '--pretty=%B', commitHash], { allowNonZeroExit: true });
		return exitCode === 0 ? stdout.trim() : '';
	}

	public async getHeadCommitHash(repoRoot: string): Promise<string> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['rev-parse', 'HEAD'], { allowNonZeroExit: true });
		return exitCode === 0 ? stdout.trim() : '';
	}

	public async rewordHeadCommit(repoRoot: string, newMessage: string): Promise<void> {
		await this.execGit(repoRoot, ['commit', '--amend', '--only', '-m', newMessage]);
	}

	public async formatCommitPatch(repoRoot: string, commitHash: string): Promise<string> {
		const { stdout } = await this.execGit(repoRoot, ['format-patch', '-1', commitHash, '--stdout']);
		return stdout;
	}

	public async showFullCommit(repoRoot: string, commitHash: string): Promise<string> {
		const { stdout } = await this.execGit(repoRoot, ['show', '--stat', '--patch', commitHash], { allowNonZeroExit: true });
		return stdout;
	}

	public async dropSingleCommit(repoRoot: string, commitHash: string): Promise<GitExecResult> {
		return this.execGit(repoRoot, ['rebase', '--onto', `${commitHash}~1`, commitHash], { allowNonZeroExit: true });
	}

	public async restoreFileAtRevision(repoRoot: string, commitHash: string, relativePath: string): Promise<void> {
		await this.execGit(repoRoot, ['checkout', commitHash, '--', relativePath]);
	}

	// =========================================================================
	// .gitignore & Safe Untrack (git rm --cached)
	// =========================================================================

	public async untrackFileKeepingWorkingCopy(repoRoot: string, relativePath: string): Promise<void> {
		await this.execGit(repoRoot, ['rm', '--cached', '-r', '--', relativePath], { allowNonZeroExit: true });
	}

	// =========================================================================
	// Branches, Tags, Merge, Rebase, Cherry-Pick & Reset
	// =========================================================================

	public async getBranches(repoRoot: string, protectedPatterns: string[]): Promise<GitBranchInfo[]> {
		const format = '%(HEAD)|%(refname:short)|%(refname)|%(upstream:short)|%(upstream:track)|%(objectname:short)|%(contents:subject)';
		const { stdout } = await this.execGit(repoRoot, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes']);

		const branches: GitBranchInfo[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim() || line.includes('/HEAD|')) {
				continue;
			}
			const [headMark, shortName, fullRef, upstream, trackInfo, hash, subject] = line.split('|');
			const isRemote = fullRef.startsWith('refs/remotes/');
			let ahead = 0;
			let behind = 0;
			if (trackInfo) {
				const aheadMatch = /ahead (\d+)/.exec(trackInfo);
				const behindMatch = /behind (\d+)/.exec(trackInfo);
				if (aheadMatch) {
					ahead = parseInt(aheadMatch[1], 10);
				}
				if (behindMatch) {
					behind = parseInt(behindMatch[1], 10);
				}
			}

			const isProtected = this.matchesProtectedPattern(shortName, protectedPatterns);
			branches.push({
				name: shortName,
				isCurrent: headMark === '*',
				isRemote,
				remoteName: isRemote ? shortName.split('/')[0] : undefined,
				upstream: upstream || undefined,
				ahead,
				behind,
				lastCommitHash: hash || '',
				lastCommitSubject: subject || '',
				isProtected
			});
		}

		return branches;
	}

	public matchesProtectedPattern(branchName: string, patterns: string[]): boolean {
		const cleanName = branchName.replace(/^origin\//, '');
		for (const pattern of patterns) {
			const regexSource = '^' + pattern.replace(/\*/g, '.*') + '$';
			if (new RegExp(regexSource).test(cleanName) || new RegExp(regexSource).test(branchName)) {
				return true;
			}
		}
		return false;
	}

	public async checkoutBranch(repoRoot: string, branchName: string, createNew = false, startPoint?: string): Promise<void> {
		const args = ['checkout'];
		if (createNew) {
			args.push('-b', branchName);
			if (startPoint) {
				args.push(startPoint);
			}
		} else {
			args.push(branchName);
		}
		await this.execGit(repoRoot, args);
	}

	public async deleteBranch(repoRoot: string, branchName: string, force = false): Promise<void> {
		await this.execGit(repoRoot, ['branch', force ? '-D' : '-d', branchName]);
	}

	public async renameBranch(repoRoot: string, oldName: string, newName: string): Promise<void> {
		await this.execGit(repoRoot, ['branch', '-m', oldName, newName]);
	}

	public async mergeBranch(repoRoot: string, targetBranch: string): Promise<GitExecResult> {
		return this.execGit(repoRoot, ['merge', '--no-stat', '-v', targetBranch], { allowNonZeroExit: true });
	}

	public async rebaseBranch(repoRoot: string, upstreamBranch: string): Promise<GitExecResult> {
		return this.execGit(repoRoot, ['rebase', upstreamBranch], { allowNonZeroExit: true });
	}

	public async cherryPick(repoRoot: string, commitHash: string): Promise<GitExecResult> {
		return this.execGit(repoRoot, ['cherry-pick', commitHash], { allowNonZeroExit: true });
	}

	public async revertCommit(repoRoot: string, commitHash: string): Promise<GitExecResult> {
		return this.execGit(repoRoot, ['revert', '--no-edit', commitHash], { allowNonZeroExit: true });
	}

	public async resetBranch(repoRoot: string, targetCommit: string, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void> {
		await this.execGit(repoRoot, ['reset', `--${mode}`, targetCommit]);
	}

	public async createTag(repoRoot: string, tagName: string, commitHash: string, message?: string): Promise<void> {
		if (message && message.trim().length > 0) {
			await this.execGit(repoRoot, ['tag', '-a', tagName, commitHash, '-m', message.trim()]);
		} else {
			await this.execGit(repoRoot, ['tag', tagName, commitHash]);
		}
	}

	// =========================================================================
	// Remotes, Fetch, Pull / Update Project & Push
	// =========================================================================

	public async getRemotes(repoRoot: string): Promise<GitRemoteInfo[]> {
		const { stdout } = await this.execGit(repoRoot, ['remote', '-v']);
		const map = new Map<string, { fetchUrl: string; pushUrl: string }>();

		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const parts = line.trim().split(/\s+/);
			const name = parts[0];
			const url = parts[1] ?? '';
			const kind = parts[2] ?? '';
			const existing = map.get(name) ?? { fetchUrl: url, pushUrl: url };
			if (kind.includes('fetch')) {
				existing.fetchUrl = url;
			} else if (kind.includes('push')) {
				existing.pushUrl = url;
			}
			map.set(name, existing);
		}

		return Array.from(map.entries()).map(([name, urls]) => ({
			name,
			fetchUrl: urls.fetchUrl,
			pushUrl: urls.pushUrl
		}));
	}

	public async addRemote(repoRoot: string, name: string, url: string): Promise<void> {
		await this.execGit(repoRoot, ['remote', 'add', name, url]);
	}

	public async removeRemote(repoRoot: string, name: string): Promise<void> {
		await this.execGit(repoRoot, ['remote', 'remove', name]);
	}

	public async fetchAll(repoRoot: string): Promise<void> {
		await this.execGit(repoRoot, ['fetch', '--all', '--prune']);
	}

	public async updateProject(repoRoot: string, strategy: 'merge' | 'rebase' | 'reset'): Promise<GitExecResult> {
		await this.fetchAll(repoRoot);
		if (strategy === 'merge') {
			return this.execGit(repoRoot, ['pull', '--no-rebase'], { allowNonZeroExit: true });
		}
		if (strategy === 'rebase') {
			return this.execGit(repoRoot, ['pull', '--rebase'], { allowNonZeroExit: true });
		}
		const status = await this.getRepositoryStatus(repoRoot);
		const targetUpstream = status.upstream || `origin/${status.branch}`;
		return this.execGit(repoRoot, ['reset', '--hard', targetUpstream], { allowNonZeroExit: true });
	}

	public async push(
		repoRoot: string,
		options?: {
			remote?: string;
			branch?: string;
			upToCommitSha?: string;
			forceWithLease?: boolean;
			pushTags?: 'none' | 'all' | 'follow';
			setUpstream?: boolean;
		}
	): Promise<void> {
		const args = ['push'];
		if (options?.forceWithLease) {
			args.push('--force-with-lease');
		}
		if (options?.setUpstream) {
			args.push('--set-upstream');
		}
		if (options?.pushTags === 'all') {
			args.push('--tags');
		} else if (options?.pushTags === 'follow') {
			args.push('--follow-tags');
		}

		const remote = options?.remote || 'origin';
		if (options?.upToCommitSha && options?.branch) {
			args.push(remote, `${options.upToCommitSha}:refs/heads/${options.branch}`);
		} else if (options?.branch) {
			args.push(remote, options.branch);
		}

		await this.execGit(repoRoot, args);
	}

	// =========================================================================
	// 3-Way Conflict Stages & File Revision Content
	// =========================================================================

	public async showFileAtRevision(repoRoot: string, revisionSpec: string): Promise<string> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['show', revisionSpec], { allowNonZeroExit: true });
		return exitCode === 0 ? stdout : '';
	}

	public async getConflictStages(repoRoot: string, relativePath: string): Promise<ConflictStages> {
		const normalizedPath = relativePath.replace(/\\/g, '/');
		const [baseContent, yoursContent, theirsContent] = await Promise.all([
			this.showFileAtRevision(repoRoot, `:1:${normalizedPath}`),
			this.showFileAtRevision(repoRoot, `:2:${normalizedPath}`),
			this.showFileAtRevision(repoRoot, `:3:${normalizedPath}`)
		]);

		let workingCopyContent: string;
		try {
			workingCopyContent = await fs.readFile(path.join(repoRoot, normalizedPath), 'utf8');
		} catch {
			workingCopyContent = '';
		}

		return {
			repoRoot,
			relativePath: normalizedPath,
			baseContent,
			yoursContent,
			theirsContent,
			workingCopyContent
		};
	}

	// =========================================================================
	// Commit History, DAG Log, File History & Line Range History (-L)
	// =========================================================================

	public async getCommitLog(repoRoot: string, filter?: GitLogFilter): Promise<GitCommitLogEntry[]> {
		const maxCount = filter?.maxCount ?? 250;
		const sep = '\x1f';
		const format = `%H${sep}%h${sep}%P${sep}%an${sep}%ae${sep}%aI${sep}%cI${sep}%D${sep}%s`;
		const args: string[] = ['log', `--max-count=${maxCount}`, `--pretty=format:${format}`];

		if (filter?.branch && filter.branch.trim() && filter.branch !== 'ALL') {
			args.push(filter.branch.trim());
		} else {
			args.push('--all');
		}

		if (filter?.user && filter.user.trim()) {
			args.push(`--author=${filter.user.trim()}`);
		}

		if (filter?.dateRange && filter.dateRange !== 'all') {
			if (filter.dateRange === 'today') {
				args.push('--since=midnight');
			} else if (filter.dateRange === '7days') {
				args.push('--since=7.days.ago');
			} else if (filter.dateRange === '30days') {
				args.push('--since=30.days.ago');
			} else {
				args.push(`--since=${filter.dateRange}`);
			}
		}

		if (filter?.searchPattern && filter.searchPattern.trim()) {
			args.push(`--grep=${filter.searchPattern.trim()}`);
			args.push('-i');
			if (filter.isRegex) {
				args.push('-E');
			}
		}

		if (filter?.pathFilter && filter.pathFilter.trim()) {
			args.push('--follow', '--', filter.pathFilter.trim().replace(/\\/g, '/'));
		}

		const { stdout, exitCode } = await this.execGit(repoRoot, args, { allowNonZeroExit: true });
		if (exitCode !== 0 || !stdout.trim()) {
			return [];
		}

		const entries: GitCommitLogEntry[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const [hash, shortHash, parentsRaw, authorName, authorEmail, authorDateIso, committerDateIso, refsRaw, subject] = line.split(sep);
			if (!hash) {
				continue;
			}
			const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
			const refs = refsRaw
				? refsRaw.split(',').map(r => r.trim()).filter(Boolean)
				: [];

			entries.push({
				hash,
				shortHash,
				parents,
				authorName,
				authorEmail,
				authorDateIso,
				committerDateIso,
				subject: subject || '',
				refs
			});
		}

		return this.assignSwimlanes(entries);
	}

	private assignSwimlanes(entries: GitCommitLogEntry[]): GitCommitLogEntry[] {
		const activeLanes: (string | null)[] = [];

		for (const entry of entries) {
			let lane = activeLanes.indexOf(entry.hash);
			if (lane === -1) {
				lane = activeLanes.indexOf(null);
				if (lane === -1) {
					lane = activeLanes.length;
					activeLanes.push(entry.hash);
				} else {
					activeLanes[lane] = entry.hash;
				}
			}

			entry.lane = lane;
			entry.colorIndex = lane % 8;

			if (entry.parents.length === 0) {
				activeLanes[lane] = null;
			} else {
				activeLanes[lane] = entry.parents[0];
				for (let i = 1; i < entry.parents.length; i++) {
					const parentHash = entry.parents[i];
					if (!activeLanes.includes(parentHash)) {
						const emptySlot = activeLanes.indexOf(null);
						if (emptySlot !== -1) {
							activeLanes[emptySlot] = parentHash;
						} else {
							activeLanes.push(parentHash);
						}
					}
				}
			}
		}

		return entries;
	}

	public async getCommitChangedFiles(repoRoot: string, commitHash: string): Promise<CommitFileDelta[]> {
		const { stdout } = await this.execGit(
			repoRoot,
			['diff-tree', '--no-commit-id', '--name-status', '-r', '-m', '--root', commitHash],
			{ allowNonZeroExit: true }
		);

		const deltas: CommitFileDelta[] = [];
		const seen = new Set<string>();
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const parts = line.split('\t');
			const status = parts[0]?.trim() || 'M';
			const relPath = (parts[2] || parts[1] || '').replace(/\\/g, '/');
			if (!relPath || seen.has(relPath)) {
				continue;
			}
			seen.add(relPath);
			deltas.push({
				status,
				relativePath: relPath,
				oldRelativePath: parts[2] ? parts[1]?.replace(/\\/g, '/') : undefined
			});
		}
		return deltas;
	}

	public async getSelectionHistory(repoRoot: string, relativePath: string, startLine: number, endLine: number): Promise<string> {
		const normalized = relativePath.replace(/\\/g, '/');
		const { stdout } = await this.execGit(
			repoRoot,
			['log', `-L${startLine},${endLine}:${normalized}`, '--max-count=25'],
			{ allowNonZeroExit: true }
		);
		return stdout;
	}

	// =========================================================================
	// Git Blame (--porcelain)
	// =========================================================================

	public async getFileBlame(repoRoot: string, relativePath: string): Promise<BlameLineInfo[]> {
		const normalized = relativePath.replace(/\\/g, '/');
		const { stdout, exitCode } = await this.execGit(
			repoRoot,
			['blame', '--porcelain', '--', normalized],
			{ allowNonZeroExit: true }
		);
		if (exitCode !== 0 || !stdout) {
			return [];
		}

		const result: BlameLineInfo[] = [];
		const commitMeta = new Map<string, { author: string; authorEmail: string; authorTime: number; summary: string }>();

		const lines = stdout.split(/\r?\n/);
		let currentHash = '';
		let currentFinalLine = 0;

		for (const line of lines) {
			const headerMatch = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)/.exec(line);
			if (headerMatch) {
				currentHash = headerMatch[1];
				currentFinalLine = parseInt(headerMatch[3], 10);
				if (!commitMeta.has(currentHash)) {
					commitMeta.set(currentHash, {
						author: 'Unknown',
						authorEmail: '',
						authorTime: 0,
						summary: ''
					});
				}
				continue;
			}

			const meta = commitMeta.get(currentHash);
			if (meta) {
				if (line.startsWith('author ')) {
					meta.author = line.slice('author '.length).trim();
				} else if (line.startsWith('author-mail ')) {
					meta.authorEmail = line.slice('author-mail '.length).trim();
				} else if (line.startsWith('author-time ')) {
					meta.authorTime = parseInt(line.slice('author-time '.length).trim(), 10) || 0;
				} else if (line.startsWith('summary ')) {
					meta.summary = line.slice('summary '.length).trim();
				} else if (line.startsWith('\t')) {
					result.push({
						lineNumber: currentFinalLine,
						hash: currentHash,
						shortHash: currentHash.slice(0, 7),
						author: meta.author,
						authorEmail: meta.authorEmail,
						authorTimestampSec: meta.authorTime,
						summary: meta.summary
					});
				}
			}
		}

		return result;
	}

	// =========================================================================
	// Submodules, Worktrees, Stash & Diff Patches (Shelf)
	// =========================================================================

	public async getSubmodules(repoRoot: string): Promise<SubmoduleInfo[]> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['submodule', 'status'], { allowNonZeroExit: true });
		if (exitCode !== 0 || !stdout.trim()) {
			return [];
		}

		const submodules: SubmoduleInfo[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const prefix = line[0];
			const rest = line.slice(1).trim();
			const parts = rest.split(/\s+/);
			const sha = parts[0] || '';
			const relativePath = parts[1] || '';
			const describe = parts.slice(2).join(' ').replace(/^\(|\)$/g, '');
			submodules.push({
				name: path.basename(relativePath),
				relativePath,
				fullPath: path.join(repoRoot, relativePath),
				sha: sha.slice(0, 8),
				branchOrTag: describe || 'detached',
				isDetached: prefix === '+' || !describe,
				isUninitialized: prefix === '-'
			});
		}
		return submodules;
	}

	public async listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
		const { stdout, exitCode } = await this.execGit(repoRoot, ['worktree', 'list', '--porcelain'], { allowNonZeroExit: true });
		if (exitCode !== 0 || !stdout.trim()) {
			return [];
		}

		const worktrees: WorktreeInfo[] = [];
		const blocks = stdout.trim().split(/\r?\n\r?\n/);
		blocks.forEach((block, index) => {
			let worktreePath = '';
			let headSha = '';
			let branch = 'HEAD (detached)';
			let isBare = false;
			let isDetached = false;

			for (const line of block.split(/\r?\n/)) {
				if (line.startsWith('worktree ')) {
					worktreePath = line.slice('worktree '.length).trim();
				} else if (line.startsWith('HEAD ')) {
					headSha = line.slice('HEAD '.length).trim().slice(0, 8);
				} else if (line.startsWith('branch ')) {
					branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
				} else if (line === 'bare') {
					isBare = true;
				} else if (line === 'detached') {
					isDetached = true;
				}
			}

			if (worktreePath) {
				worktrees.push({
					repoRoot,
					worktreePath,
					headSha,
					branch,
					isBare,
					isMain: index === 0,
					isDetached
				});
			}
		});

		return worktrees;
	}

	public async addWorktree(repoRoot: string, targetPath: string, branchName: string, startPoint?: string): Promise<void> {
		const args = ['worktree', 'add', '-b', branchName, targetPath];
		if (startPoint) {
			args.push(startPoint);
		}
		await this.execGit(repoRoot, args);
	}

	public async removeWorktree(repoRoot: string, targetPath: string, force = false): Promise<void> {
		const args = ['worktree', 'remove'];
		if (force) {
			args.push('--force');
		}
		args.push(targetPath);
		await this.execGit(repoRoot, args);
	}

	public async listStashes(repoRoot: string): Promise<StashEntry[]> {
		const { stdout } = await this.execGit(repoRoot, ['stash', 'list', '--format=%gd|%gs'], { allowNonZeroExit: true });
		const stashes: StashEntry[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const [ref, subject] = line.split('|');
			const indexMatch = /stash@\{(\d+)\}/.exec(ref || '');
			const index = indexMatch ? parseInt(indexMatch[1], 10) : stashes.length;
			stashes.push({
				index,
				ref: ref || `stash@{${index}}`,
				branch: '',
				message: subject || '',
				repoRoot
			});
		}
		return stashes;
	}

	public async createStash(repoRoot: string, message: string, keepIndex = false, includeUntracked = true): Promise<void> {
		const args = ['stash', 'push', '-m', message];
		if (keepIndex) {
			args.push('--keep-index');
		}
		if (includeUntracked) {
			args.push('--include-untracked');
		}
		await this.execGit(repoRoot, args);
	}

	public async popStash(repoRoot: string, stashRef: string): Promise<void> {
		await this.execGit(repoRoot, ['stash', 'pop', stashRef]);
	}

	public async createDiffPatch(repoRoot: string, relativePaths?: string[]): Promise<string> {
		const args = ['diff', 'HEAD', '--binary'];
		if (relativePaths && relativePaths.length > 0) {
			args.push('--', ...relativePaths);
		}
		const { stdout } = await this.execGit(repoRoot, args);
		return stdout;
	}

	public async applyPatchFile(repoRoot: string, patchFilePath: string, threeWay = true): Promise<GitExecResult> {
		const args = ['apply'];
		if (threeWay) {
			args.push('--3way');
		}
		args.push(patchFilePath);
		return this.execGit(repoRoot, args, { allowNonZeroExit: true });
	}

	public dispose(): void {
		this._onDidRunGitCommand.dispose();
		this.outputChannel.dispose();
	}
}
