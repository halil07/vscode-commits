import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from '../../core/gitCliService';
import { GitLogFilter } from '../../core/types';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { ProtectedBranchGuard } from './protectedBranchGuard';
import { InteractiveRebasePanel } from '../branches/interactiveRebasePanel';

/**
 * Commits & Console Panel (`Alt+9`) (`commitPro.logView`).
 * Features a refined IDE-grade UI/UX:
 * - Unified compact toolbar with Branch `<select>` dropdown, inline search + `[.*]` Regex toggle, author/date/path filters
 * - Continuous multi-lane Swimlane SVG DAG graph with smooth Bezier fork/merge curves
 * - Sticky table header, author initials avatars, refined ref pills (`HEAD`, Local, Remote, Tag), and keyboard navigation (`↑`/`↓`)
 * - Resizable split layout with Commit Inspector card & formatted Changed Files list (filename + directory path + status badge)
 * - Rich right-click Context Menus on both Commits and Changed Files
 */
export class GitLogViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'commitPro.logView';
	private view?: vscode.WebviewView;
	private currentFilter: GitLogFilter = {
		branch: 'ALL',
		dateRange: 'all',
		isRegex: false,
		maxCount: 250
	};

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly scmProvider: CommitProScmProvider,
		private readonly protectedGuard: ProtectedBranchGuard,
		private readonly interactiveRebase: InteractiveRebasePanel
	) {
		this.scmProvider.onDidUpdateStatus(() => {
			void this.refreshLogData();
		});
		this.gitCli.onDidRunGitCommand(() => {
			this.postConsoleHistory();
		});
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async msg => {
			const repo = this.repoManager.getActiveRepository();
			if (!repo) {
				return;
			}

			switch (msg.type) {
				case 'ready':
				case 'refresh':
					await this.refreshLogData();
					this.postConsoleHistory();
					break;

				case 'toolbarGitAction':
					if (msg.command === 'fetch') {
						await vscode.commands.executeCommand('commitPro.fetch');
					} else if (msg.command === 'pull') {
						await vscode.commands.executeCommand('commitPro.updateProject');
					} else if (msg.command === 'push') {
						await vscode.commands.executeCommand('commitPro.push');
					} else if (msg.command === 'branches') {
						await vscode.commands.executeCommand('commitPro.showBranchesPopup');
					}
					break;

				case 'applyFilter':
					this.currentFilter = {
						branch: msg.branch || 'ALL',
						user: msg.user || '',
						dateRange: msg.dateRange || 'all',
						pathFilter: msg.pathFilter || '',
						searchPattern: msg.searchPattern || '',
						isRegex: Boolean(msg.isRegex),
						maxCount: 250
					};
					await this.refreshLogData();
					break;

				case 'selectCommit': {
					const [files, fullMessage] = await Promise.all([
						this.gitCli.getCommitChangedFiles(repo.rootPath, msg.hash as string),
						this.gitCli.getCommitMessage(repo.rootPath, msg.hash as string)
					]);
					this.view?.webview.postMessage({
						type: 'commitDetails',
						hash: msg.hash,
						subject: msg.subject || '',
						fullMessage: fullMessage || msg.subject || '',
						authorName: msg.authorName || '',
						authorEmail: msg.authorEmail || '',
						authorDateIso: msg.authorDateIso || '',
						refs: msg.refs || [],
						files
					});
					break;
				}

				case 'openCommitFileDiff': {
					const commitHash = msg.hash as string;
					const relPath = msg.relativePath as string;
					const shortSha = commitHash.slice(0, 7);
					const beforeUri = this.scmProvider.createRevisionUri(repo.rootPath, relPath, `${commitHash}~1`);
					const afterUri = this.scmProvider.createRevisionUri(repo.rootPath, relPath, commitHash);
					await vscode.commands.executeCommand(
						'vscode.diff',
						beforeUri,
						afterUri,
						`${path.basename(relPath)} (${shortSha}~1 ↔ ${shortSha})`
					);
					break;
				}

				case 'fileAction':
					await this.handleFileAction(
						repo.rootPath,
						msg.action as string,
						msg.hash as string,
						msg.relativePath as string
					);
					break;

				case 'commitAction':
					await this.handleCommitAction(
						repo.rootPath,
						repo.currentBranch,
						msg.action as string,
						msg.hash as string,
						msg.subject as string | undefined
					);
					break;
			}
		});

		void this.refreshLogData();
	}

	public async focusWithFilter(branchFilter?: string, pathFilter?: string): Promise<void> {
		if (branchFilter) {
			this.currentFilter.branch = branchFilter;
		}
		if (pathFilter !== undefined) {
			this.currentFilter.pathFilter = pathFilter;
		}
		this.view?.show?.(true);
		await this.refreshLogData();
	}

	private async refreshLogData(): Promise<void> {
		if (!this.view) {
			return;
		}
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const [commits, branches] = await Promise.all([
			this.gitCli.getCommitLog(repo.rootPath, this.currentFilter),
			this.gitCli.getBranches(repo.rootPath, this.protectedGuard.getProtectedPatterns())
		]);

		const localBranches = branches
			.filter(b => !b.isRemote)
			.map(b => ({ name: b.name, isCurrent: b.isCurrent }));
		const remoteBranches = branches
			.filter(b => b.isRemote)
			.map(b => ({ name: b.name, isCurrent: false }));

		this.view.webview.postMessage({
			type: 'logData',
			repoName: repo.name,
			currentBranch: repo.currentBranch,
			ahead: repo.ahead,
			behind: repo.behind,
			filter: this.currentFilter,
			localBranches,
			remoteBranches,
			commits
		});
	}

	private postConsoleHistory(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.postMessage({
			type: 'consoleData',
			commands: this.gitCli.getCommandHistory().slice(0, 80)
		});
	}

	private async handleFileAction(
		repoRoot: string,
		action: string,
		commitHash: string,
		relativePath: string
	): Promise<void> {
		const shortSha = commitHash.slice(0, 7);
		switch (action) {
			case 'diffCommit': {
				const beforeUri = this.scmProvider.createRevisionUri(repoRoot, relativePath, `${commitHash}~1`);
				const afterUri = this.scmProvider.createRevisionUri(repoRoot, relativePath, commitHash);
				await vscode.commands.executeCommand(
					'vscode.diff',
					beforeUri,
					afterUri,
					`${path.basename(relativePath)} (${shortSha}~1 ↔ ${shortSha})`
				);
				break;
			}

			case 'compareWithLocal': {
				const revUri = this.scmProvider.createRevisionUri(repoRoot, relativePath, commitHash);
				const localUri = vscode.Uri.file(path.join(repoRoot, relativePath));
				await vscode.commands.executeCommand(
					'vscode.diff',
					revUri,
					localUri,
					`${path.basename(relativePath)} (${shortSha} ↔ Working Tree)`
				);
				break;
			}

			case 'openRevision': {
				const revUri = this.scmProvider.createRevisionUri(repoRoot, relativePath, commitHash);
				const docRev = await vscode.workspace.openTextDocument(revUri);
				await vscode.window.showTextDocument(docRev, { preview: true });
				break;
			}

			case 'openLocalFile': {
				const localUri = vscode.Uri.file(path.join(repoRoot, relativePath));
				await vscode.window.showTextDocument(localUri, { preview: false });
				break;
			}

			case 'restoreFile': {
				const confirm = await vscode.window.showWarningMessage(
					`Restore '${relativePath}' in working tree to its state at commit ${shortSha}?`,
					{ modal: true },
					'Restore File'
				);
				if (confirm !== 'Restore File') {
					return;
				}
				await this.gitCli.restoreFileAtRevision(repoRoot, commitHash, relativePath);
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Restored '${relativePath}' from ${shortSha}.`);
				break;
			}

			case 'fileHistory':
				this.currentFilter.pathFilter = relativePath;
				await this.refreshLogData();
				break;

			case 'copyPath':
				await vscode.env.clipboard.writeText(relativePath);
				vscode.window.showInformationMessage(`Copied path '${relativePath}'.`);
				break;
		}
	}

	private async handleCommitAction(
		repoRoot: string,
		currentBranch: string,
		action: string,
		commitHash: string,
		commitSubject?: string
	): Promise<void> {
		const shortSha = commitHash.slice(0, 7);

		switch (action) {
			case 'checkoutRevision': {
				const confirm = await vscode.window.showWarningMessage(
					`Checkout revision ${shortSha}? This will put the repository in Detached HEAD state.`,
					{ modal: true },
					'Checkout Revision'
				);
				if (confirm !== 'Checkout Revision') {
					return;
				}
				await this.gitCli.checkoutBranch(repoRoot, commitHash, false);
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Checked out revision ${shortSha}.`);
				break;
			}

			case 'newBranchFromCommit': {
				const newBranchName = await vscode.window.showInputBox({
					prompt: `Create and checkout new branch starting at ${shortSha}`,
					placeHolder: 'feature/my-branch'
				});
				if (!newBranchName || !newBranchName.trim()) {
					return;
				}
				await this.gitCli.checkoutBranch(repoRoot, newBranchName.trim(), true, commitHash);
				this.currentFilter.branch = newBranchName.trim();
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Created and checked out branch '${newBranchName.trim()}' at ${shortSha}.`);
				break;
			}

			case 'cherryPick': {
				const res = await this.gitCli.cherryPick(repoRoot, commitHash);
				await this.scmProvider.refreshRepository(repoRoot);
				if (res.exitCode === 0) {
					vscode.window.showInformationMessage(`Cherry-picked commit ${shortSha}.`);
				} else {
					vscode.window.showWarningMessage(
						`Cherry-pick of ${shortSha} paused due to conflicts. Use 'Resolve Conflicts in 3-Pane Merge Editor' to resolve.`
					);
				}
				break;
			}

			case 'rewordCommit': {
				if (!this.protectedGuard.canRewriteHistory(currentBranch, 'Edit Commit Message (Reword)')) {
					return;
				}
				const headHash = await this.gitCli.getHeadCommitHash(repoRoot);
				if (headHash === commitHash) {
					const existingMsg = await this.gitCli.getCommitMessage(repoRoot, commitHash);
					const updatedMsg = await vscode.window.showInputBox({
						prompt: `Edit commit message for HEAD (${shortSha})`,
						value: existingMsg
					});
					if (!updatedMsg || !updatedMsg.trim()) {
						return;
					}
					await this.gitCli.rewordHeadCommit(repoRoot, updatedMsg.trim());
					await this.scmProvider.refreshRepository(repoRoot);
					vscode.window.showInformationMessage(`Updated commit message for ${shortSha}.`);
				} else {
					await this.interactiveRebase.openInteractiveRebase(commitHash);
				}
				break;
			}

			case 'interactiveRebase':
				await this.interactiveRebase.openInteractiveRebase(commitHash);
				break;

			case 'revert': {
				const res = await this.gitCli.revertCommit(repoRoot, commitHash);
				await this.scmProvider.refreshRepository(repoRoot);
				if (res.exitCode === 0) {
					vscode.window.showInformationMessage(`Reverted commit ${shortSha} (created new revert commit).`);
				} else {
					vscode.window.showWarningMessage(`Revert of ${shortSha} encountered conflicts.`);
				}
				break;
			}

			case 'undoCommit': {
				if (!this.protectedGuard.canRewriteHistory(currentBranch, 'Undo Commit')) {
					return;
				}
				await this.gitCli.undoLastCommit(repoRoot);
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Undid last commit (${shortSha}) and kept changes staged.`);
				break;
			}

			case 'dropCommit': {
				if (!this.protectedGuard.canRewriteHistory(currentBranch, 'Drop Commit')) {
					return;
				}
				const confirm = await vscode.window.showWarningMessage(
					`Drop commit ${shortSha} (${commitSubject || ''}) from branch '${currentBranch}'?`,
					{ modal: true },
					'Drop Commit'
				);
				if (confirm !== 'Drop Commit') {
					return;
				}
				const res = await this.gitCli.dropSingleCommit(repoRoot, commitHash);
				await this.scmProvider.refreshRepository(repoRoot);
				if (res.exitCode === 0) {
					vscode.window.showInformationMessage(`Dropped commit ${shortSha}.`);
				} else {
					vscode.window.showWarningMessage(`Drop commit paused due to conflicts: ${res.stderr.trim()}`);
				}
				break;
			}

			case 'reset': {
				const modePick = await vscode.window.showQuickPick(
					[
						{ label: 'Soft (--soft)', mode: 'soft' as const, description: 'Keep all changes staged' },
						{ label: 'Mixed (--mixed)', mode: 'mixed' as const, description: 'Keep changes in working tree, unstage index' },
						{ label: 'Keep (--keep)', mode: 'keep' as const, description: 'Reset and preserve uncommitted local changes safely' },
						{ label: 'Hard (--hard)', mode: 'hard' as const, description: '⚠️ Discard all working tree & index changes after target commit' }
					],
					{ placeHolder: `Reset current branch '${currentBranch}' to ${shortSha}` }
				);
				if (!modePick) {
					return;
				}
				if (modePick.mode === 'hard' && !this.protectedGuard.canRewriteHistory(currentBranch, 'Hard Reset')) {
					return;
				}
				await this.gitCli.resetBranch(repoRoot, commitHash, modePick.mode);
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Reset '${currentBranch}' (${modePick.mode}) to ${shortSha}.`);
				break;
			}

			case 'tag': {
				const tagName = await vscode.window.showInputBox({
					prompt: `New Tag name at ${shortSha}`,
					placeHolder: 'v1.2.0'
				});
				if (!tagName || !tagName.trim()) {
					return;
				}
				const message = await vscode.window.showInputBox({
					prompt: 'Tag annotation message (optional — leave empty for lightweight tag)'
				});
				await this.gitCli.createTag(repoRoot, tagName.trim(), commitHash, message);
				await this.refreshLogData();
				vscode.window.showInformationMessage(`Created tag '${tagName.trim()}' on ${shortSha}.`);
				break;
			}

			case 'pushUpToHere':
				await this.protectedGuard.pushInteractive(repoRoot, commitHash);
				break;

			case 'showFullCommitDiff': {
				const diffUri = this.scmProvider.createPatchUri(repoRoot, `commit-${shortSha}.diff`, commitHash, false);
				const doc = await vscode.workspace.openTextDocument(diffUri);
				await vscode.window.showTextDocument(doc, { preview: true });
				break;
			}

			case 'createPatch': {
				const patchUri = this.scmProvider.createPatchUri(repoRoot, `${shortSha}.patch`, commitHash, true);
				const doc = await vscode.workspace.openTextDocument(patchUri);
				await vscode.window.showTextDocument(doc, { preview: true });
				break;
			}

			case 'copyHash':
				await vscode.env.clipboard.writeText(commitHash);
				this.view?.webview.postMessage({ type: 'toast', message: `Copied SHA ${shortSha}` });
				break;

			case 'copySubject':
				if (commitSubject) {
					await vscode.env.clipboard.writeText(commitSubject);
					this.view?.webview.postMessage({ type: 'toast', message: 'Copied commit message' });
				}
				break;
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	:root {
		--row-height: 28px;
		--border-subtle: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
		--accent: var(--vscode-focusBorder, #388bfd);
	}
	* {
		box-sizing: border-box;
	}
	body {
		margin: 0;
		padding: 0;
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
		font-size: 12px;
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		user-select: none;
	}

	/* Unified Top Toolbar */
	.top-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
		border-bottom: 1px solid var(--border-subtle);
		flex-wrap: wrap;
	}
	.mode-tabs {
		display: inline-flex;
		background: rgba(128, 128, 128, 0.12);
		border-radius: 5px;
		padding: 2px;
		gap: 2px;
	}
	.tab-btn {
		background: transparent;
		color: var(--vscode-foreground);
		border: none;
		border-radius: 4px;
		padding: 3px 10px;
		cursor: pointer;
		font-size: 11.5px;
		font-weight: 600;
		opacity: 0.78;
		transition: all 0.12s ease;
	}
	.tab-btn:hover {
		opacity: 1;
	}
	.tab-btn.active {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		opacity: 1;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
	}
	.toolbar-divider {
		width: 1px;
		height: 18px;
		background: var(--border-subtle);
		margin: 0 2px;
	}

	/* Branch Select Pill */
	.branch-pill {
		display: inline-flex;
		align-items: center;
		background: var(--vscode-dropdown-background, var(--vscode-input-background));
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
		border-radius: 5px;
		padding: 0 4px 0 8px;
		height: 25px;
		gap: 5px;
		transition: border-color 0.12s ease;
	}
	.branch-pill:focus-within {
		border-color: var(--accent);
	}
	.branch-icon {
		color: #58a6ff;
		font-size: 12px;
		font-weight: 700;
	}
	#fBranch {
		background: transparent;
		color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
		border: none;
		outline: none;
		font-size: 11.5px;
		font-weight: 600;
		min-width: 175px;
		max-width: 240px;
		height: 23px;
		cursor: pointer;
	}
	#fBranch option, #fBranch optgroup {
		background: var(--vscode-dropdown-background, #252526);
		color: var(--vscode-dropdown-foreground, #cccccc);
	}

	/* Search Input with Inline Regex Toggle */
	.search-box {
		display: inline-flex;
		align-items: center;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
		border-radius: 5px;
		height: 25px;
		padding: 0 3px 0 7px;
		gap: 4px;
	}
	.search-box:focus-within {
		border-color: var(--accent);
	}
	.search-box input {
		background: transparent;
		color: var(--vscode-input-foreground);
		border: none;
		outline: none;
		font-size: 11.5px;
		width: 145px;
	}
	.regex-toggle {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 10.5px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		cursor: pointer;
		background: transparent;
		color: var(--vscode-foreground);
		opacity: 0.6;
		border: 1px solid transparent;
	}
	.regex-toggle:hover {
		opacity: 0.9;
		background: rgba(128, 128, 128, 0.15);
	}
	.regex-toggle.active {
		opacity: 1;
		background: rgba(56, 139, 253, 0.25);
		color: #79c0ff;
		border-color: rgba(56, 139, 253, 0.5);
	}

	/* Compact Filter Inputs */
	.compact-input, .compact-select {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
		border-radius: 5px;
		height: 25px;
		padding: 0 7px;
		font-size: 11.5px;
		outline: none;
	}
	.compact-input:focus, .compact-select:focus {
		border-color: var(--accent);
	}
	.btn-icon {
		background: rgba(128, 128, 128, 0.14);
		color: var(--vscode-foreground);
		border: 1px solid transparent;
		border-radius: 5px;
		height: 25px;
		padding: 0 8px;
		cursor: pointer;
		font-size: 11.5px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		transition: background 0.12s ease;
	}
	.btn-icon:hover {
		background: rgba(128, 128, 128, 0.25);
	}
	.btn-primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn-primary:hover {
		background: var(--vscode-button-hoverBackground);
	}

	.toolbar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.meta-pill {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 10px;
		background: rgba(128, 128, 128, 0.15);
		opacity: 0.85;
		font-weight: 600;
	}

	/* Main Resizable Split Layout */
	.split-layout {
		display: flex;
		flex: 1;
		overflow: hidden;
		position: relative;
	}
	.log-section {
		flex: 1;
		min-width: 340px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.resizer {
		width: 4px;
		cursor: col-resize;
		background: var(--border-subtle);
		transition: background 0.15s ease;
		flex-shrink: 0;
	}
	.resizer:hover, .resizer.dragging {
		background: var(--accent);
	}
	.details-pane {
		width: 380px;
		min-width: 260px;
		max-width: 65vw;
		overflow-y: auto;
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		display: flex;
		flex-direction: column;
	}

	/* Sticky Table Header & Rows */
	.table-header {
		display: grid;
		grid-template-columns: 105px 1fr 145px 100px 76px;
		align-items: center;
		height: 25px;
		padding: 0 10px;
		background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
		border-bottom: 1px solid var(--border-subtle);
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		opacity: 0.72;
		flex-shrink: 0;
	}
	.log-table-wrap {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		outline: none;
	}
	.commit-row {
		display: grid;
		grid-template-columns: 105px 1fr 145px 100px 76px;
		align-items: center;
		height: var(--row-height);
		padding: 0 10px;
		border-bottom: 1px solid rgba(128, 128, 128, 0.07);
		cursor: pointer;
		transition: background 0.06s ease;
	}
	.commit-row:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.commit-row.selected {
		background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
	}
	.graph-cell {
		height: var(--row-height);
		display: flex;
		align-items: center;
		overflow: hidden;
	}
	.subject-cell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 6px;
		padding-right: 10px;
	}
	.commit-subject-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}
	.commit-row.is-head .commit-subject-text {
		font-weight: 600;
	}

	/* Refined Ref Pills */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 10.5px;
		padding: 1px 6px;
		border-radius: 4px;
		font-weight: 600;
		flex-shrink: 0;
		line-height: 1.35;
	}
	.badge-head {
		background: rgba(240, 136, 62, 0.18);
		border: 1px solid rgba(240, 136, 62, 0.65);
		color: #ff9b50;
	}
	.badge-local {
		background: rgba(46, 160, 67, 0.18);
		border: 1px solid rgba(46, 160, 67, 0.5);
		color: #7ee787;
	}
	.badge-remote {
		background: rgba(56, 139, 253, 0.18);
		border: 1px solid rgba(56, 139, 253, 0.5);
		color: #79c0ff;
	}
	.badge-tag {
		background: rgba(210, 153, 34, 0.16);
		border: 1px solid rgba(210, 153, 34, 0.45);
		color: #e3b341;
	}

	/* Author Cell with Avatar */
	.author-cell {
		display: flex;
		align-items: center;
		gap: 6px;
		overflow: hidden;
		padding-right: 8px;
	}
	.avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 9.5px;
		font-weight: 700;
		color: #ffffff;
		flex-shrink: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
	}
	.author-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.9;
		font-size: 11.5px;
	}
	.date-cell {
		opacity: 0.72;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.hash-cell code {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(128, 128, 128, 0.12);
		opacity: 0.88;
	}

	/* Right-Hand Details Inspector */
	.inspector-empty {
		padding: 28px 16px;
		text-align: center;
		opacity: 0.6;
		line-height: 1.5;
	}
	.inspector-card {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border-subtle);
		background: rgba(128, 128, 128, 0.04);
	}
	.inspector-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.sha-chip {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px;
		padding: 2px 7px;
		border-radius: 4px;
		background: rgba(56, 139, 253, 0.16);
		color: #79c0ff;
		cursor: pointer;
		border: 1px solid rgba(56, 139, 253, 0.35);
	}
	.sha-chip:hover {
		background: rgba(56, 139, 253, 0.28);
	}
	.inspector-msg {
		font-size: 12.5px;
		font-weight: 600;
		line-height: 1.4;
		margin-bottom: 6px;
		white-space: pre-wrap;
		word-break: break-word;
		user-select: text;
	}
	.inspector-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		opacity: 0.78;
	}
	.inspector-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border-subtle);
	}
	.act-pill {
		background: rgba(128, 128, 128, 0.14);
		color: var(--vscode-foreground);
		border: 1px solid rgba(128, 128, 128, 0.2);
		border-radius: 4px;
		padding: 3px 8px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.1s ease;
	}
	.act-pill:hover {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border-color: transparent;
	}

	/* Changed Files Section */
	.files-header {
		padding: 7px 12px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		opacity: 0.78;
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid rgba(128, 128, 128, 0.1);
	}
	.files-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 6px;
	}
	.file-row {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 4px 6px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 11.5px;
	}
	.file-row:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.status-badge {
		width: 17px;
		height: 17px;
		border-radius: 3px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: 700;
		font-family: var(--vscode-editor-font-family, monospace);
		flex-shrink: 0;
	}
	.st-M { background: rgba(210, 153, 34, 0.22); color: #e3b341; }
	.st-A { background: rgba(46, 160, 67, 0.22); color: #7ee787; }
	.st-D { background: rgba(248, 81, 73, 0.22); color: #ff7b72; }
	.st-R { background: rgba(188, 140, 255, 0.22); color: #d2a8ff; }
	.file-name {
		font-weight: 600;
		white-space: nowrap;
	}
	.file-dir {
		opacity: 0.55;
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.file-diff-hint {
		opacity: 0;
		font-size: 10.5px;
		padding: 1px 5px;
		border-radius: 3px;
		background: rgba(128, 128, 128, 0.2);
	}
	.file-row:hover .file-diff-hint {
		opacity: 0.85;
	}

	/* Console View */
	#consoleView {
		display: none;
		flex: 1;
		overflow: auto;
		padding: 8px 14px;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11.5px;
	}
	.cmd-entry {
		padding: 5px 0;
		border-bottom: 1px solid rgba(128, 128, 128, 0.12);
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* Context Menus */
	.context-menu {
		position: fixed;
		display: none;
		z-index: 9999;
		min-width: 255px;
		background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
		color: var(--vscode-menu-foreground, var(--vscode-foreground, #cccccc));
		border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #454545));
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		padding: 4px;
		animation: menuFadeIn 0.09s ease-out;
	}
	@keyframes menuFadeIn {
		from { opacity: 0; transform: scale(0.97); }
		to { opacity: 1; transform: scale(1); }
	}
	.ctx-header {
		padding: 4px 10px 5px;
		font-size: 11px;
		font-weight: 600;
		opacity: 0.68;
		border-bottom: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,0.22));
		margin-bottom: 3px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 270px;
	}
	.ctx-item {
		padding: 5px 10px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 12px;
	}
	.ctx-item:hover {
		background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #094771));
		color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
	}
	.ctx-item.danger {
		color: #ff7b72;
	}
	.ctx-item.danger:hover {
		background: rgba(248, 81, 73, 0.25);
		color: #ffa198;
	}
	.ctx-icon {
		width: 15px;
		text-align: center;
		font-size: 12px;
		opacity: 0.85;
	}
	.ctx-hint {
		margin-left: auto;
		font-size: 10.5px;
		opacity: 0.55;
	}
	.ctx-sep {
		height: 1px;
		margin: 3px 4px;
		background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.22));
	}

	/* Toast Notification */
	#toast {
		position: fixed;
		bottom: 14px;
		right: 16px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		padding: 6px 12px;
		border-radius: 5px;
		font-size: 11.5px;
		font-weight: 600;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s ease;
		z-index: 10000;
	}
	#toast.visible {
		opacity: 1;
	}
</style>
</head>
<body>
	<div class="top-toolbar">
		<div class="mode-tabs">
			<button class="tab-btn active" id="tabLog">Commits</button>
			<button class="tab-btn" id="tabConsole">Console</button>
		</div>

		<div class="toolbar-divider"></div>

		<!-- Branch Selectbox -->
		<div class="branch-pill" title="Select a branch to immediately list its commits">
			<span class="branch-icon">⎇</span>
			<select id="fBranch">
				<option value="ALL">All Branches (--all)</option>
				<option value="HEAD">HEAD (Current Branch)</option>
			</select>
		</div>

		<!-- Search + Inline Regex Toggle -->
		<div class="search-box">
			<span style="opacity:0.55;font-size:11px;">🔍</span>
			<input type="text" id="fSearch" placeholder="Filter message or hash...">
			<button type="button" class="regex-toggle" id="fRegexBtn" title="Toggle Regular Expression Search">.*</button>
		</div>

		<input type="text" class="compact-input" id="fUser" placeholder="Author..." style="width:105px;">

		<select class="compact-select" id="fDate">
			<option value="all">Date: All</option>
			<option value="today">Today</option>
			<option value="7days">Last 7 Days</option>
			<option value="30days">Last 30 Days</option>
		</select>

		<input type="text" class="compact-input" id="fPath" placeholder="Path / file..." style="width:120px;">

		<button class="btn-icon btn-primary" id="applyFilterBtn">Filter</button>
		<button class="btn-icon" id="resetFilterBtn" title="Reset all filters">✕ Clear</button>

		<div class="toolbar-right">
			<span class="meta-pill" id="commitCountBadge">0 commits</span>
			<button class="btn-icon" data-git="branches" title="Open Branches Switcher">⎇ <span id="repoInfo">Repo</span></button>
			<button class="btn-icon" data-git="fetch" title="Fetch All Remotes">⟳ Fetch</button>
			<button class="btn-icon" data-git="pull" title="Update Project (Pull)">↓ Pull</button>
			<button class="btn-icon" data-git="push" title="Push Commits">↑ Push</button>
		</div>
	</div>

	<div id="logViewContainer" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
		<div class="split-layout">
			<div class="log-section">
				<div class="table-header">
					<div>Graph</div>
					<div>Commit Message &amp; Refs</div>
					<div>Author</div>
					<div>Date</div>
					<div>SHA</div>
				</div>
				<div class="log-table-wrap" id="commitList" tabindex="0"></div>
			</div>

			<div class="resizer" id=" paneResizer"></div>

			<div class="details-pane" id="detailsPane">
				<div class="inspector-empty">Select or right-click a commit to inspect changed files &amp; run commit actions.</div>
			</div>
		</div>
	</div>

	<div id="consoleView"></div>

	<!-- Commit Right-Click Context Menu -->
	<div class="context-menu" id="commitContextMenu">
		<div class="ctx-header" id="ctxMenuHeader">Commit</div>
		<div class="ctx-item" data-act="checkoutRevision"><span class="ctx-icon">↱</span><span>Checkout Revision</span><span class="ctx-hint">Detached HEAD</span></div>
		<div class="ctx-item" data-act="newBranchFromCommit"><span class="ctx-icon">⎇</span><span>New Branch from Here...</span><span class="ctx-hint">checkout -b</span></div>
		<div class="ctx-item" data-act="tag"><span class="ctx-icon">🏷</span><span>New Tag at Commit...</span><span class="ctx-hint">git tag</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item" data-act="cherryPick"><span class="ctx-icon">🍒</span><span>Cherry-Pick Commit</span><span class="ctx-hint">cherry-pick</span></div>
		<div class="ctx-item" data-act="rewordCommit"><span class="ctx-icon">✎</span><span>Edit Commit Message (Reword)...</span></div>
		<div class="ctx-item" data-act="interactiveRebase"><span class="ctx-icon">⇄</span><span>Interactively Rebase from Here...</span><span class="ctx-hint">rebase -i</span></div>
		<div class="ctx-item" data-act="revert"><span class="ctx-icon">↶</span><span>Revert Commit</span><span class="ctx-hint">git revert</span></div>
		<div class="ctx-item" data-act="undoCommit"><span class="ctx-icon">Undo</span><span>Undo Last Commit (Soft Reset)</span><span class="ctx-hint">HEAD~1</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item danger" data-act="reset"><span class="ctx-icon">↺</span><span>Reset Current Branch to Here...</span><span class="ctx-hint">Soft/Mixed/Hard</span></div>
		<div class="ctx-item danger" data-act="dropCommit"><span class="ctx-icon">🗑</span><span>Drop Commit</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item" data-act="pushUpToHere"><span class="ctx-icon">↑</span><span>Push All Commits up to Here...</span></div>
		<div class="ctx-item" data-act="showFullCommitDiff"><span class="ctx-icon">📄</span><span>Show Full Commit Diff in Editor</span></div>
		<div class="ctx-item" data-act="createPatch"><span class="ctx-icon">🩹</span><span>Create Patch from Commit</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item" data-act="copyHash"><span class="ctx-icon">📋</span><span>Copy Commit Revision SHA</span></div>
		<div class="ctx-item" data-act="copySubject"><span class="ctx-icon">📝</span><span>Copy Commit Subject</span></div>
	</div>

	<!-- Changed File Right-Click Context Menu -->
	<div class="context-menu" id="fileContextMenu">
		<div class="ctx-header" id="fileCtxHeader">File</div>
		<div class="ctx-item" data-file-act="diffCommit"><span class="ctx-icon">⇄</span><span>Show Commit Diff</span></div>
		<div class="ctx-item" data-file-act="compareWithLocal"><span class="ctx-icon">◫</span><span>Compare with Local Working Tree</span></div>
		<div class="ctx-item" data-file-act="openRevision"><span class="ctx-icon">📄</span><span>Open File at This Revision</span></div>
		<div class="ctx-item" data-file-act="openLocalFile"><span class="ctx-icon">✎</span><span>Open Working Tree File</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item" data-file-act="fileHistory"><span class="ctx-icon">🕓</span><span>Filter Commits by This File</span></div>
		<div class="ctx-item danger" data-file-act="restoreFile"><span class="ctx-icon">↺</span><span>Restore File from This Commit...</span></div>
		<div class="ctx-sep"></div>
		<div class="ctx-item" data-file-act="copyPath"><span class="ctx-icon">📋</span><span>Copy Relative Path</span></div>
	</div>

	<div id="toast"></div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const LANE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f78166', '#bc8cff', '#39c5cf', '#ff7b72', '#a5d6ff'];
		let currentCommits = [];
		let selectedCommit = null;
		let contextCommit = null;
		let contextFile = null;
		let isRegexActive = false;

		const tabLog = document.getElementById('tabLog');
		const tabConsole = document.getElementById('tabConsole');
		const logViewContainer = document.getElementById('logViewContainer');
		const consoleView = document.getElementById('consoleView');
		const fBranch = document.getElementById('fBranch');
		const fRegexBtn = document.getElementById('fRegexBtn');
		const commitListEl = document.getElementById('commitList');
		const detailsPaneEl = document.getElementById('detailsPane');
		const ctxMenu = document.getElementById('commitContextMenu');
		const ctxMenuHeader = document.getElementById('ctxMenuHeader');
		const fileCtxMenu = document.getElementById('fileContextMenu');
		const fileCtxHeader = document.getElementById('fileCtxHeader');
		const toastEl = document.getElementById('toast');

		function showToast(text) {
			toastEl.textContent = text;
			toastEl.classList.add('visible');
			setTimeout(() => toastEl.classList.remove('visible'), 1800);
		}

		// Tab Switching
		tabLog.addEventListener('click', () => {
			tabLog.classList.add('active');
			tabConsole.classList.remove('active');
			logViewContainer.style.display = 'flex';
			consoleView.style.display = 'none';
		});
		tabConsole.addEventListener('click', () => {
			tabConsole.classList.add('active');
			tabLog.classList.remove('active');
			logViewContainer.style.display = 'none';
			consoleView.style.display = 'block';
		});

		// Toolbar Git Quick Actions
		document.querySelectorAll('button[data-git]').forEach(btn => {
			btn.addEventListener('click', () => {
				vscode.postMessage({ type: 'toolbarGitAction', command: btn.getAttribute('data-git') });
			});
		});

		// Regex Toggle Pill
		fRegexBtn.addEventListener('click', () => {
			isRegexActive = !isRegexActive;
			fRegexBtn.classList.toggle('active', isRegexActive);
			submitFilter();
		});

		function submitFilter() {
			vscode.postMessage({
				type: 'applyFilter',
				searchPattern: document.getElementById('fSearch').value,
				isRegex: isRegexActive,
				branch: fBranch.value || 'ALL',
				user: document.getElementById('fUser').value,
				dateRange: document.getElementById('fDate').value,
				pathFilter: document.getElementById('fPath').value
			});
		}

		fBranch.addEventListener('change', submitFilter);
		document.getElementById('fDate').addEventListener('change', submitFilter);
		['fSearch', 'fUser', 'fPath'].forEach(id => {
			document.getElementById(id).addEventListener('keydown', e => {
				if (e.key === 'Enter') submitFilter();
			});
		});

		document.getElementById('applyFilterBtn').addEventListener('click', submitFilter);
		document.getElementById('resetFilterBtn').addEventListener('click', () => {
			document.getElementById('fSearch').value = '';
			isRegexActive = false;
			fRegexBtn.classList.remove('active');
			fBranch.value = 'ALL';
			document.getElementById('fUser').value = '';
			document.getElementById('fDate').value = 'all';
			document.getElementById('fPath').value = '';
			submitFilter();
		});

		// Draggable Splitter
		const resizer = document.querySelector('.resizer');
		let isResizing = false;
		resizer.addEventListener('mousedown', () => {
			isResizing = true;
			resizer.classList.add('dragging');
		});
		window.addEventListener('mousemove', e => {
			if (!isResizing) return;
			const newWidth = window.innerWidth - e.clientX;
			if (newWidth >= 260 && newWidth <= window.innerWidth * 0.65) {
				detailsPaneEl.style.width = newWidth + 'px';
			}
		});
		window.addEventListener('mouseup', () => {
			if (isResizing) {
				isResizing = false;
				resizer.classList.remove('dragging');
			}
		});

		function populateBranchSelect(localBranches, remoteBranches, currentBranch, selectedValue) {
			fBranch.innerHTML = '';

			const optAll = document.createElement('option');
			optAll.value = 'ALL';
			optAll.textContent = 'All Branches (--all)';
			fBranch.appendChild(optAll);

			const optHead = document.createElement('option');
			optHead.value = 'HEAD';
			optHead.textContent = 'HEAD (' + (currentBranch || 'current') + ')';
			fBranch.appendChild(optHead);

			if (localBranches && localBranches.length > 0) {
				const localGroup = document.createElement('optgroup');
				localGroup.label = 'Local Branches';
				localBranches.forEach(b => {
					const opt = document.createElement('option');
					opt.value = b.name;
					opt.textContent = (b.isCurrent ? '★ ' : '   ') + b.name;
					localGroup.appendChild(opt);
				});
				fBranch.appendChild(localGroup);
			}

			if (remoteBranches && remoteBranches.length > 0) {
				const remoteGroup = document.createElement('optgroup');
				remoteGroup.label = 'Remote Branches';
				remoteBranches.forEach(b => {
					const opt = document.createElement('option');
					opt.value = b.name;
					opt.textContent = '   ' + b.name;
					remoteGroup.appendChild(opt);
				});
				fBranch.appendChild(remoteGroup);
			}

			const targetVal = selectedValue || 'ALL';
			const exists = Array.from(fBranch.options).some(o => o.value === targetVal);
			if (!exists && targetVal !== 'ALL') {
				const customOpt = document.createElement('option');
				customOpt.value = targetVal;
				customOpt.textContent = targetVal;
				fBranch.appendChild(customOpt);
			}
			fBranch.value = targetVal;
		}

		// Context Menus Management
		function hideAllMenus() {
			ctxMenu.style.display = 'none';
			fileCtxMenu.style.display = 'none';
		}
		window.addEventListener('click', hideAllMenus);
		window.addEventListener('keydown', e => {
			if (e.key === 'Escape') hideAllMenus();
		});
		commitListEl.addEventListener('scroll', hideAllMenus);

		function positionPopup(menuEl, clientX, clientY) {
			menuEl.style.display = 'block';
			const w = menuEl.offsetWidth || 260;
			const h = menuEl.offsetHeight || 340;
			const left = Math.min(clientX, Math.max(8, window.innerWidth - w - 8));
			const top = Math.min(clientY, Math.max(8, window.innerHeight - h - 8));
			menuEl.style.left = left + 'px';
			menuEl.style.top = top + 'px';
		}

		ctxMenu.querySelectorAll('.ctx-item[data-act]').forEach(item => {
			item.addEventListener('click', e => {
				e.stopPropagation();
				const action = item.getAttribute('data-act');
				hideAllMenus();
				if (contextCommit && action) {
					vscode.postMessage({
						type: 'commitAction',
						action,
						hash: contextCommit.hash,
						subject: contextCommit.subject
					});
				}
			});
		});

		fileCtxMenu.querySelectorAll('.ctx-item[data-file-act]').forEach(item => {
			item.addEventListener('click', e => {
				e.stopPropagation();
				const action = item.getAttribute('data-file-act');
				hideAllMenus();
				if (contextFile && action) {
					vscode.postMessage({
						type: 'fileAction',
						action,
						hash: contextFile.hash,
						relativePath: contextFile.relativePath
					});
				}
			});
		});

		// Author Initials & Color
		function getAuthorAvatar(name) {
			const clean = String(name || '?').trim();
			const parts = clean.split(/\\s+/);
			const initials = parts.length >= 2
				? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
				: clean.slice(0, 2).toUpperCase();
			let hash = 0;
			for (let i = 0; i < clean.length; i++) {
				hash = clean.charCodeAt(i) + ((hash << 5) - hash);
			}
			const hue = Math.abs(hash) % 360;
			return { initials, bg: 'hsl(' + hue + ', 55%, 42%)' };
		}

		function escapeHtml(str) {
			return String(str || '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');
		}

		// Continuous Swimlane DAG Graph Generator
		function computeGraphModels(commits) {
			const activeLanes = [];
			return commits.map(c => {
				let lane = activeLanes.indexOf(c.hash);
				const wasExistingLane = lane !== -1;
				if (lane === -1) {
					lane = activeLanes.indexOf(null);
					if (lane === -1) {
						lane = activeLanes.length;
						activeLanes.push(c.hash);
					} else {
						activeLanes[lane] = c.hash;
					}
				}

				const topLanes = activeLanes.map((h, idx) => (idx === lane && !wasExistingLane ? null : h));
				const parents = c.parents || [];
				const parentConnections = [];

				if (parents.length === 0) {
					activeLanes[lane] = null;
				} else {
					activeLanes[lane] = parents[0];
					parentConnections.push({ fromLane: lane, toLane: lane, colorIdx: lane });

					for (let p = 1; p < parents.length; p++) {
						const pHash = parents[p];
						let pLane = activeLanes.indexOf(pHash);
						if (pLane === -1) {
							pLane = activeLanes.indexOf(null);
							if (pLane === -1) {
								pLane = activeLanes.length;
								activeLanes.push(pHash);
							} else {
								activeLanes[pLane] = pHash;
							}
						}
						parentConnections.push({ fromLane: lane, toLane: pLane, colorIdx: pLane });
					}
				}

				// Deduplicate lanes pointing to the same commit
				const seen = new Map();
				for (let i = 0; i < activeLanes.length; i++) {
					const h = activeLanes[i];
					if (!h) continue;
					if (seen.has(h)) {
						const target = seen.get(h);
						parentConnections.push({ fromLane: i, toLane: target, colorIdx: i });
						activeLanes[i] = null;
					} else {
						seen.set(h, i);
					}
				}

				const bottomLanes = [...activeLanes];
				return {
					lane,
					wasExistingLane,
					topLanes,
					bottomLanes,
					parentConnections,
					isMerge: parents.length > 1,
					isHead: (c.refs || []).some(r => r.includes('HEAD'))
				};
			});
		}

		function renderSwimlaneSvg(g) {
			const H = 28;
			const MID = 14;
			const xOf = l => 14 + (l % 6) * 14;
			const colOf = l => LANE_COLORS[l % LANE_COLORS.length];
			let svg = '<svg width="100" height="' + H + '">';

			// Top half pass-through lines
			g.topLanes.forEach((h, idx) => {
				if (h) {
					const x = xOf(idx);
					svg += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + MID + '" stroke="' + colOf(idx) + '" stroke-width="2"/>';
				}
			});

			// Bottom half pass-through lines
			g.bottomLanes.forEach((h, idx) => {
				if (h && idx !== g.lane) {
					const x = xOf(idx);
					svg += '<line x1="' + x + '" y1="' + MID + '" x2="' + x + '" y2="' + H + '" stroke="' + colOf(idx) + '" stroke-width="2"/>';
				}
			});

			// Parent connections & curves
			g.parentConnections.forEach(conn => {
				const x1 = xOf(conn.fromLane);
				const x2 = xOf(conn.toLane);
				const stroke = colOf(conn.colorIdx);
				if (x1 === x2) {
					svg += '<line x1="' + x1 + '" y1="' + MID + '" x2="' + x2 + '" y2="' + H + '" stroke="' + stroke + '" stroke-width="2"/>';
				} else {
					svg += '<path d="M ' + x1 + ' ' + MID + ' C ' + x1 + ' ' + (H - 4) + ', ' + x2 + ' ' + (MID + 4) + ', ' + x2 + ' ' + H + '" stroke="' + stroke + '" stroke-width="2" fill="none"/>';
				}
			});

			// Node circle
			const cx = xOf(g.lane);
			const nodeColor = colOf(g.lane);
			if (g.isHead) {
				svg += '<circle cx="' + cx + '" cy="' + MID + '" r="6" fill="var(--vscode-editor-background)" stroke="#ff9b50" stroke-width="2"/>';
				svg += '<circle cx="' + cx + '" cy="' + MID + '" r="3" fill="#ff9b50"/>';
			} else if (g.isMerge) {
				svg += '<circle cx="' + cx + '" cy="' + MID + '" r="4.5" fill="var(--vscode-editor-background)" stroke="' + nodeColor + '" stroke-width="2.2"/>';
			} else {
				svg += '<circle cx="' + cx + '" cy="' + MID + '" r="4" fill="' + nodeColor + '" stroke="var(--vscode-editor-background)" stroke-width="1.5"/>';
			}

			svg += '</svg>';
			return svg;
		}

		function renderBadges(refs) {
			if (!refs || refs.length === 0) return '';
			return refs.map(r => {
				if (r.includes('HEAD ->')) {
					const branch = r.replace('HEAD ->', '').trim();
					return '<span class="badge badge-head">● ' + escapeHtml(branch) + '</span>';
				}
				if (r === 'HEAD') {
					return '<span class="badge badge-head">● HEAD</span>';
				}
				if (r.startsWith('tag:')) {
					const tag = r.replace(/^tag:\\s*/, '').trim();
					return '<span class="badge badge-tag">🏷 ' + escapeHtml(tag) + '</span>';
				}
				if (r.includes('/')) {
					return '<span class="badge badge-remote">⎇ ' + escapeHtml(r) + '</span>';
				}
				return '<span class="badge badge-local">⎇ ' + escapeHtml(r) + '</span>';
			}).join('');
		}

		function selectCommitObj(c, rowEl) {
			selectedCommit = c.hash;
			commitListEl.querySelectorAll('.commit-row').forEach(r => r.classList.remove('selected'));
			if (rowEl) {
				rowEl.classList.add('selected');
				rowEl.scrollIntoView({ block: 'nearest' });
			}
			vscode.postMessage({
				type: 'selectCommit',
				hash: c.hash,
				subject: c.subject,
				authorName: c.authorName,
				authorEmail: c.authorEmail,
				authorDateIso: c.authorDateIso,
				refs: c.refs || []
			});
		}

		// Keyboard Navigation (Up / Down Arrows)
		commitListEl.addEventListener('keydown', e => {
			if (!currentCommits.length) return;
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const idx = currentCommits.findIndex(c => c.hash === selectedCommit);
				const nextIdx = e.key === 'ArrowDown'
					? Math.min(currentCommits.length - 1, idx + 1)
					: Math.max(0, idx - 1);
				const rows = commitListEl.querySelectorAll('.commit-row');
				if (currentCommits[nextIdx]) {
					selectCommitObj(currentCommits[nextIdx], rows[nextIdx]);
				}
			}
		});

		function renderLog(commits) {
			currentCommits = commits || [];
			document.getElementById('commitCountBadge').textContent = currentCommits.length + ' commits';
			commitListEl.innerHTML = '';

			if (currentCommits.length === 0) {
				commitListEl.innerHTML = '<div class="inspector-empty">No commits match the selected branch or filter criteria.</div>';
				return;
			}

			const graphModels = computeGraphModels(currentCommits);

			currentCommits.forEach((c, idx) => {
				const g = graphModels[idx];
				const avatar = getAuthorAvatar(c.authorName);
				const row = document.createElement('div');
				row.className = 'commit-row' +
					(selectedCommit === c.hash ? ' selected' : '') +
					(g.isHead ? ' is-head' : '');

				const dateFormatted = (c.authorDateIso || '').slice(0, 16).replace('T', ' ');
				row.innerHTML =
					'<div class="graph-cell">' + renderSwimlaneSvg(g) + '</div>' +
					'<div class="subject-cell">' + renderBadges(c.refs) + '<span class="commit-subject-text" title="' + escapeHtml(c.subject) + '">' + escapeHtml(c.subject) + '</span></div>' +
					'<div class="author-cell"><span class="avatar" style="background:' + avatar.bg + ';">' + escapeHtml(avatar.initials) + '</span><span class="author-name" title="' + escapeHtml(c.authorName) + '">' + escapeHtml(c.authorName) + '</span></div>' +
					'<div class="date-cell">' + escapeHtml(dateFormatted.slice(0, 10)) + '</div>' +
					'<div class="hash-cell"><code>' + escapeHtml(c.shortHash) + '</code></div>';

				row.addEventListener('click', () => {
					hideAllMenus();
					selectCommitObj(c, row);
				});

				row.addEventListener('contextmenu', e => {
					e.preventDefault();
					e.stopPropagation();
					fileCtxMenu.style.display = 'none';
					selectCommitObj(c, row);
					contextCommit = c;
					ctxMenuHeader.textContent = c.shortHash + ' — ' + c.subject;
					positionPopup(ctxMenu, e.clientX, e.clientY);
				});

				commitListEl.appendChild(row);
			});

			// Auto-select first commit if none selected
			const existingIdx = currentCommits.findIndex(c => c.hash === selectedCommit);
			const rows = commitListEl.querySelectorAll('.commit-row');
			if (existingIdx === -1 && currentCommits.length > 0) {
				selectCommitObj(currentCommits[0], rows[0]);
			}
		}

		function renderDetails(msg) {
			const hash = msg.hash;
			const files = msg.files || [];
			const avatar = getAuthorAvatar(msg.authorName);
			const dateStr = (msg.authorDateIso || '').slice(0, 16).replace('T', ' ');

			detailsPaneEl.innerHTML =
				'<div class="inspector-card">' +
					'<div class="inspector-top">' +
						'<span class="sha-chip" id="copyShaChip" title="Click to copy full commit SHA">📋 ' + escapeHtml(hash.slice(0, 10)) + '</span>' +
						'<span style="font-size:11px;opacity:0.65;">' + escapeHtml(dateStr) + '</span>' +
					'</div>' +
					'<div class="inspector-msg">' + escapeHtml(msg.fullMessage || msg.subject) + '</div>' +
					'<div class="inspector-meta">' +
						'<span class="avatar" style="background:' + avatar.bg + ';">' + escapeHtml(avatar.initials) + '</span>' +
						'<strong>' + escapeHtml(msg.authorName) + '</strong>' +
						(msg.authorEmail ? '<span>&lt;' + escapeHtml(msg.authorEmail) + '&gt;</span>' : '') +
					'</div>' +
				'</div>' +
				'<div class="inspector-actions">' +
					'<button class="act-pill" data-act="checkoutRevision" title="Checkout this commit">↱ Checkout</button>' +
					'<button class="act-pill" data-act="newBranchFromCommit" title="Create branch from here">⎇ +Branch</button>' +
					'<button class="act-pill" data-act="cherryPick" title="Cherry-pick this commit">🍒 Cherry-Pick</button>' +
					'<button class="act-pill" data-act="interactiveRebase" title="Interactive Rebase from here">⇄ Rebase</button>' +
					'<button class="act-pill" data-act="rewordCommit" title="Edit commit message">✎ Reword</button>' +
					'<button class="act-pill" data-act="revert" title="Revert commit">↶ Revert</button>' +
					'<button class="act-pill" data-act="reset" title="Reset current branch to here">↺ Reset…</button>' +
					'<button class="act-pill" data-act="tag" title="Create tag at commit">🏷 +Tag</button>' +
				'</div>' +
				'<div class="files-header">' +
					'<span>Changed Files (' + files.length + ')</span>' +
					'<span style="font-size:10px;text-transform:none;font-weight:400;">Click for Diff • Right-click for options</span>' +
				'</div>' +
				'<div class="files-list" id="changedFilesList"></div>';

			document.getElementById('copyShaChip').addEventListener('click', () => {
				vscode.postMessage({ type: 'commitAction', action: 'copyHash', hash });
			});

			detailsPaneEl.querySelectorAll('button[data-act]').forEach(btn => {
				btn.addEventListener('click', () => {
					vscode.postMessage({
						type: 'commitAction',
						action: btn.getAttribute('data-act'),
						hash,
						subject: msg.subject
					});
				});
			});

			const filesBox = detailsPaneEl.querySelector('#changedFilesList');
			files.forEach(f => {
				const stLetter = (f.status || 'M')[0].toUpperCase();
				const stClass = ['M', 'A', 'D', 'R'].includes(stLetter) ? 'st-' + stLetter : 'st-M';
				const slashIdx = f.relativePath.lastIndexOf('/');
				const fileName = slashIdx >= 0 ? f.relativePath.slice(slashIdx + 1) : f.relativePath;
				const dirPath = slashIdx >= 0 ? f.relativePath.slice(0, slashIdx) : '';

				const item = document.createElement('div');
				item.className = 'file-row';
				item.innerHTML =
					'<span class="status-badge ' + stClass + '">' + escapeHtml(stLetter) + '</span>' +
					'<span class="file-name"' + (stLetter === 'D' ? ' style="text-decoration:line-through;opacity:0.7;"' : '') + '>' + escapeHtml(fileName) + '</span>' +
					'<span class="file-dir">' + escapeHtml(dirPath) + '</span>' +
					'<span class="file-diff-hint">Diff</span>';

				item.addEventListener('click', () => {
					hideAllMenus();
					vscode.postMessage({
						type: 'openCommitFileDiff',
						hash,
						relativePath: f.relativePath
					});
				});

				item.addEventListener('contextmenu', e => {
					e.preventDefault();
					e.stopPropagation();
					ctxMenu.style.display = 'none';
					contextFile = { hash, relativePath: f.relativePath };
					fileCtxHeader.textContent = fileName + ' (' + hash.slice(0, 7) + ')';
					positionPopup(fileCtxMenu, e.clientX, e.clientY);
				});

				filesBox.appendChild(item);
			});
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'logData') {
				const syncBadge = (msg.ahead ? ' ↑' + msg.ahead : '') + (msg.behind ? ' ↓' + msg.behind : '');
				document.getElementById('repoInfo').textContent = msg.repoName + ' • ' + msg.currentBranch + syncBadge;
				populateBranchSelect(
					msg.localBranches || [],
					msg.remoteBranches || [],
					msg.currentBranch,
					msg.filter ? msg.filter.branch : 'ALL'
				);
				if (msg.filter) {
					document.getElementById('fPath').value = msg.filter.pathFilter || '';
				}
				renderLog(msg.commits || []);
			} else if (msg.type === 'commitDetails') {
				renderDetails(msg);
			} else if (msg.type === 'consoleData') {
				consoleView.innerHTML = (msg.commands || []).map(cmd =>
					'<div class="cmd-entry">' +
						'<span style="opacity:0.55;">' + escapeHtml(cmd.timestampIso.slice(11, 19)) + '</span>' +
						'<code style="color:#79c0ff;font-weight:600;">' + escapeHtml(cmd.command) + '</code>' +
						'<span style="margin-left:auto;opacity:0.65;">' + cmd.durationMs + 'ms • exit ' + cmd.exitCode + '</span>' +
					'</div>'
				).join('');
			} else if (msg.type === 'toast') {
				showToast(msg.message);
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}

	public dispose(): void {}
}
