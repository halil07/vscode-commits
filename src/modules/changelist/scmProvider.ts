import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from '../../core/gitCliService';
import { GitFileChange, StagingMode } from '../../core/types';
import { RepositoryManager } from '../repository/repositoryManager';
import { ChangelistStore } from './changelistStore';

export const COMMIT_PRO_ORIG_SCHEME = 'commitpro-orig';

interface RepoScmContext {
	readonly watcher: vscode.FileSystemWatcher;
	latestChanges: GitFileChange[];
	inputBoxValue: string;
}

/**
 * Repository Status Watcher & Original Revision Content Provider.
 * Keeps the left Source Control panel clean (using standard built-in VS Code Git)
 * while watching `.git` and working tree changes to keep the bottom `Commits` panel updated.
 */
export class CommitProScmProvider implements vscode.TextDocumentContentProvider, vscode.QuickDiffProvider, vscode.Disposable {
	private readonly scmByRepo = new Map<string, RepoScmContext>();
	private readonly _onDidChangeOriginalContent = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChangeOriginalContent.event;

	private readonly _onDidUpdateStatus = new vscode.EventEmitter<string>();
	public readonly onDidUpdateStatus = this._onDidUpdateStatus.event;

	private refreshTimer?: NodeJS.Timeout;

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly changelistStore: ChangelistStore
	) {
		this.repoManager.onDidChangeRepositories(() => {
			void this.syncAllRepositories();
		});
		this.changelistStore.onDidChangeChangelists(repoRoot => {
			void this.refreshRepository(repoRoot);
		});
	}

	public getStagingMode(): StagingMode {
		return vscode.workspace
			.getConfiguration('commitPro')
			.get<StagingMode>('stagingMode', 'changelist');
	}

	public async toggleStagingModeInteractive(): Promise<void> {
		const config = vscode.workspace.getConfiguration('commitPro');
		const current = this.getStagingMode();
		const next: StagingMode = current === 'changelist' ? 'index' : 'changelist';
		await config.update('stagingMode', next, vscode.ConfigurationTarget.Workspace);
		vscode.window.showInformationMessage(
			`Switched local change management to ${next === 'changelist' ? 'Changelists' : 'Git Native Staging Index'} mode.`
		);
		await this.syncAllRepositories();
	}

	public getLatestChanges(repoRoot: string): GitFileChange[] {
		return this.scmByRepo.get(repoRoot)?.latestChanges ?? [];
	}

	public getInputBoxValue(repoRoot: string): string {
		return this.scmByRepo.get(repoRoot)?.inputBoxValue ?? '';
	}

	public setInputBoxValue(repoRoot: string, message: string): void {
		const ctx = this.scmByRepo.get(repoRoot);
		if (ctx) {
			ctx.inputBoxValue = message;
		}
	}

	public async syncAllRepositories(): Promise<void> {
		const currentRoots = new Set(this.repoManager.getRepositories().map(r => r.rootPath));

		for (const [rootPath, ctx] of this.scmByRepo.entries()) {
			if (!currentRoots.has(rootPath)) {
				this.disposeRepoContext(ctx);
				this.scmByRepo.delete(rootPath);
			}
		}

		for (const repo of this.repoManager.getRepositories()) {
			if (!this.scmByRepo.has(repo.rootPath)) {
				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(repo.rootUri, '**/*')
				);
				const scheduleRefresh = (uri: vscode.Uri) => {
					if (
						uri.fsPath.includes(`${path.sep}.git${path.sep}`) &&
						!uri.fsPath.endsWith('index') &&
						!uri.fsPath.endsWith('HEAD') &&
						!uri.fsPath.includes(`${path.sep}refs${path.sep}`)
					) {
						return;
					}
					this.scheduleDebouncedRefresh(repo.rootPath);
				};
				watcher.onDidChange(scheduleRefresh);
				watcher.onDidCreate(scheduleRefresh);
				watcher.onDidDelete(scheduleRefresh);

				this.scmByRepo.set(repo.rootPath, {
					watcher,
					latestChanges: [],
					inputBoxValue: ''
				});
			}

			await this.refreshRepository(repo.rootPath);
		}
	}

	private scheduleDebouncedRefresh(repoRoot: string): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			void this.refreshRepository(repoRoot);
		}, 350);
	}

	public async refreshRepository(repoRoot: string): Promise<void> {
		const ctx = this.scmByRepo.get(repoRoot);
		if (!ctx) {
			return;
		}

		try {
			const status = await this.gitCli.getRepositoryStatus(repoRoot);
			ctx.latestChanges = status.changes;

			const repoObj = this.repoManager.getRepositories().find(r => r.rootPath === repoRoot);
			if (repoObj) {
				repoObj.currentBranch = status.branch;
				repoObj.upstreamBranch = status.upstream;
				repoObj.ahead = status.ahead;
				repoObj.behind = status.behind;
				repoObj.isDetachedHead = status.isDetached;
			}

			await this.changelistStore.reconcileChanges(repoRoot, status.changes);

			for (const change of status.changes) {
				this._onDidChangeOriginalContent.fire(this.provideOriginalResource(change.uri));
			}

			this._onDidUpdateStatus.fire(repoRoot);
		} catch {
			// Ignore transient status lock errors
		}
	}

	public provideOriginalResource(uri: vscode.Uri): vscode.Uri {
		return uri.with({
			scheme: COMMIT_PRO_ORIG_SCHEME,
			query: JSON.stringify({ fsPath: uri.fsPath })
		});
	}

	/**
	 * Creates a read-only virtual URI (`commitpro-orig:`) preserving the original file path and extension
	 * so VS Code automatically detects the language for syntax highlighting and treats the document as Read-Only.
	 */
	public createRevisionUri(repoRoot: string, relativePath: string, revision: string): vscode.Uri {
		const normalizedRel = relativePath.replace(/\\/g, '/');
		const fullPath = path.join(repoRoot, normalizedRel);
		return vscode.Uri.file(fullPath).with({
			scheme: COMMIT_PRO_ORIG_SCHEME,
			query: JSON.stringify({
				repoRoot,
				relativePath: normalizedRel,
				revision
			})
		});
	}

	/**
	 * Creates a read-only virtual URI (`commitpro-orig:`) for a full commit diff or patch file (`.diff` / `.patch`).
	 */
	public createPatchUri(
		repoRoot: string,
		fileName: string,
		commitHash: string,
		formatPatch = false
	): vscode.Uri {
		const fullPath = path.join(repoRoot, fileName);
		return vscode.Uri.file(fullPath).with({
			scheme: COMMIT_PRO_ORIG_SCHEME,
			query: JSON.stringify({
				repoRoot,
				revision: commitHash,
				patchMode: formatPatch ? 'formatPatch' : 'fullCommit'
			})
		});
	}

	public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		try {
			const parsed = JSON.parse(uri.query) as {
				fsPath?: string;
				repoRoot?: string;
				relativePath?: string;
				revision?: string;
				patchMode?: 'fullCommit' | 'formatPatch';
			};
			if (parsed.repoRoot && parsed.revision && parsed.patchMode === 'fullCommit') {
				return await this.gitCli.showFullCommit(parsed.repoRoot, parsed.revision);
			}
			if (parsed.repoRoot && parsed.revision && parsed.patchMode === 'formatPatch') {
				return await this.gitCli.formatCommitPatch(parsed.repoRoot, parsed.revision);
			}
			if (parsed.repoRoot && parsed.relativePath && parsed.revision) {
				return await this.gitCli.showFileAtRevision(
					parsed.repoRoot,
					`${parsed.revision}:${parsed.relativePath}`
				);
			}
			if (parsed.fsPath) {
				const fileUri = vscode.Uri.file(parsed.fsPath);
				const repo = this.repoManager.getRepositoryForUri(fileUri);
				if (!repo) {
					return '';
				}
				const relPath = path.relative(repo.rootPath, fileUri.fsPath).replace(/\\/g, '/');
				return await this.gitCli.showFileAtRevision(repo.rootPath, `HEAD:${relPath}`);
			}
			return '';
		} catch {
			return '';
		}
	}

	public async openFileDiff(resourceUri?: vscode.Uri): Promise<void> {
		const targetUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!targetUri) {
			return;
		}
		const origUri = this.provideOriginalResource(targetUri);
		const fileName = path.basename(targetUri.fsPath);
		await vscode.commands.executeCommand(
			'vscode.diff',
			origUri,
			targetUri,
			`${fileName} (HEAD ↔ Working Tree)`
		);
	}

	private disposeRepoContext(ctx: RepoScmContext): void {
		ctx.watcher.dispose();
	}

	public dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		for (const ctx of this.scmByRepo.values()) {
			this.disposeRepoContext(ctx);
		}
		this.scmByRepo.clear();
		this._onDidChangeOriginalContent.dispose();
		this._onDidUpdateStatus.dispose();
	}
}
