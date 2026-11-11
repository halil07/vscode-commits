import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GitCliService } from '../../core/gitCliService';
import { ShelfEntry, StashEntry } from '../../core/types';
import { ChangelistStore } from '../changelist/changelistStore';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';

export class ShelfOrStashTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly kind: 'section' | 'shelfEntry' | 'stashEntry',
		public readonly shelfEntry?: ShelfEntry,
		public readonly stashEntry?: StashEntry,
		description?: string,
		tooltip?: string
	) {
		super(label, collapsibleState);
		this.contextValue = kind;
		this.description = description;
		this.tooltip = tooltip;
		if (kind === 'shelfEntry') {
			this.iconPath = new vscode.ThemeIcon('archive');
		} else if (kind === 'stashEntry') {
			this.iconPath = new vscode.ThemeIcon('package');
		} else {
			this.iconPath = new vscode.ThemeIcon('folder');
		}
	}
}

/**
 * Patch Shelf & Git Native Stash Manager (`commitPro.shelfView`).
 * Stores file/chunk-granular patches alongside Base revision metadata in `.vscode/commit-pro/shelf/`.
 * Supports unshelving onto dirty working trees with 3-way merge (`git apply --3way`).
 */
export class ShelfManager implements vscode.TreeDataProvider<ShelfOrStashTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ShelfOrStashTreeItem | undefined | void>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly changelistStore: ChangelistStore,
		private readonly scmProvider: CommitProScmProvider
	) {
		this.repoManager.onDidChangeRepositories(() => this.refresh());
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private getShelfDir(repoRoot: string): string {
		return path.join(repoRoot, '.vscode', 'commit-pro', 'shelf');
	}

	private getShelfIndexFile(repoRoot: string): string {
		return path.join(this.getShelfDir(repoRoot), 'shelf-index.json');
	}

	public async listShelfEntries(repoRoot: string): Promise<ShelfEntry[]> {
		try {
			const raw = await fs.readFile(this.getShelfIndexFile(repoRoot), 'utf8');
			const parsed = JSON.parse(raw) as ShelfEntry[];
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private async saveShelfEntries(repoRoot: string, entries: ShelfEntry[]): Promise<void> {
		const dir = this.getShelfDir(repoRoot);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(this.getShelfIndexFile(repoRoot), JSON.stringify(entries, null, 2), 'utf8');
	}

	public async shelveChangesInteractive(
		...resourceStates: vscode.SourceControlResourceState[]
	): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		let targetRelPaths: string[];
		if (resourceStates && resourceStates.length > 0) {
			targetRelPaths = resourceStates
				.filter(r => r && r.resourceUri)
				.map(r => path.relative(repo.rootPath, r.resourceUri.fsPath).replace(/\\/g, '/'));
		} else {
			const activeList = this.changelistStore.getActiveChangelist(repo.rootPath);
			targetRelPaths = [...activeList.files];
		}

		if (targetRelPaths.length === 0) {
			vscode.window.showWarningMessage('No modified tracked files to shelve.');
			return;
		}

		const defaultTitle = `Shelved ${targetRelPaths.length} file(s) on ${repo.currentBranch}`;
		const shelfName = await vscode.window.showInputBox({
			prompt: 'Enter name/comment for Shelf entry',
			value: defaultTitle
		});
		if (!shelfName) {
			return;
		}

		const patchContent = await this.gitCli.createDiffPatch(repo.rootPath, targetRelPaths);
		if (!patchContent.trim()) {
			vscode.window.showWarningMessage('Selected files produced an empty diff against HEAD.');
			return;
		}

		const { stdout: headShaOut } = await this.gitCli.execGit(repo.rootPath, ['rev-parse', 'HEAD'], { allowNonZeroExit: true });
		const baseCommitSha = headShaOut.trim().slice(0, 12);

		const shelfDir = this.getShelfDir(repo.rootPath);
		await fs.mkdir(shelfDir, { recursive: true });

		const id = `shelf-${Date.now()}`;
		const patchFilePath = path.join(shelfDir, `${id}.patch`);
		await fs.writeFile(patchFilePath, patchContent, 'utf8');

		const entries = await this.listShelfEntries(repo.rootPath);
		entries.unshift({
			id,
			name: shelfName.trim(),
			createdAtIso: new Date().toISOString(),
			repoRoot: repo.rootPath,
			baseCommitSha,
			patchFilePath,
			files: targetRelPaths
		});
		await this.saveShelfEntries(repo.rootPath, entries);

		const removeWorking = await vscode.window.showQuickPick(
			[
				{ label: '$(check) Shelve and Rollback from Working Tree (Standard)', remove: true },
				{ label: '$(copy) Save to Shelf Only (Keep changes in Working Tree)', remove: false }
			],
			{ placeHolder: 'Remove shelved changes from working copy?' }
		);

		if (removeWorking?.remove) {
			await this.gitCli.discardFileChanges(repo.rootPath, targetRelPaths, []);
		}

		await this.scmProvider.refreshRepository(repo.rootPath);
		this.refresh();
		vscode.window.showInformationMessage(`Shelved ${targetRelPaths.length} file(s): "${shelfName}".`);
	}

	public async unshelveChangesInteractive(item?: ShelfOrStashTreeItem): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		let target = item?.shelfEntry;
		if (!target) {
			const entries = await this.listShelfEntries(repo.rootPath);
			if (entries.length === 0) {
				vscode.window.showInformationMessage('Shelf is empty.');
				return;
			}
			const pick = await vscode.window.showQuickPick(
				entries.map(e => ({
					label: e.name,
					description: `${e.files.length} file(s) • Base: ${e.baseCommitSha}`,
					entry: e
				})),
				{ placeHolder: 'Select Shelf entry to Unshelve' }
			);
			target = pick?.entry;
		}

		if (!target) {
			return;
		}

		const res = await this.gitCli.applyPatchFile(target.repoRoot, target.patchFilePath, true);
		await this.scmProvider.refreshRepository(target.repoRoot);

		if (res.exitCode === 0) {
			vscode.window.showInformationMessage(`Unshelved "${target.name}" cleanly.`);
		} else {
			const choice = await vscode.window.showWarningMessage(
				`Unshelving "${target.name}" produced conflicts. Open 3-Pane Conflict Resolver?`,
				'Open 3-Pane Resolver',
				'Close'
			);
			if (choice === 'Open 3-Pane Resolver') {
				await vscode.commands.executeCommand('commitPro.openThreeWayMerge');
			}
		}
	}

	public async deleteShelfEntry(item?: ShelfOrStashTreeItem): Promise<void> {
		const entry = item?.shelfEntry;
		if (!entry) {
			return;
		}
		const entries = await this.listShelfEntries(entry.repoRoot);
		const remaining = entries.filter(e => e.id !== entry.id);
		await this.saveShelfEntries(entry.repoRoot, remaining);
		await fs.rm(entry.patchFilePath, { force: true });
		this.refresh();
	}

	public async stashChangesInteractive(): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		const message = await vscode.window.showInputBox({
			prompt: `Git Stash message (${repo.currentBranch})`,
			placeHolder: 'WIP: feature in progress'
		});
		if (message === undefined) {
			return;
		}
		await this.gitCli.createStash(repo.rootPath, message || `WIP on ${repo.currentBranch}`);
		await this.scmProvider.refreshRepository(repo.rootPath);
		this.refresh();
		vscode.window.showInformationMessage('Created Git Stash.');
	}

	public async unstashChangesInteractive(item?: ShelfOrStashTreeItem): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		let stashRef = item?.stashEntry?.ref;
		if (!stashRef) {
			const stashes = await this.gitCli.listStashes(repo.rootPath);
			if (stashes.length === 0) {
				vscode.window.showInformationMessage('No Git Stashes found.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				stashes.map(s => ({ label: s.ref, description: s.message })),
				{ placeHolder: 'Select Git Stash to Pop' }
			);
			stashRef = picked?.label;
		}
		if (!stashRef) {
			return;
		}
		await this.gitCli.popStash(repo.rootPath, stashRef);
		await this.scmProvider.refreshRepository(repo.rootPath);
		this.refresh();
		vscode.window.showInformationMessage(`Popped ${stashRef}.`);
	}

	public getTreeItem(element: ShelfOrStashTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: ShelfOrStashTreeItem): Promise<ShelfOrStashTreeItem[]> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return [];
		}

		if (!element) {
			return [
				new ShelfOrStashTreeItem(
					'Patch Shelf (.patch + Base Revision)',
					vscode.TreeItemCollapsibleState.Expanded,
					'section'
				),
				new ShelfOrStashTreeItem(
					'Git Native Stashes',
					vscode.TreeItemCollapsibleState.Expanded,
					'section'
				)
			];
		}

		if (element.label?.toString().startsWith('Patch Shelf')) {
			const entries = await this.listShelfEntries(repo.rootPath);
			return entries.map(
				e =>
					new ShelfOrStashTreeItem(
						e.name,
						vscode.TreeItemCollapsibleState.None,
						'shelfEntry',
						e,
						undefined,
						`${e.files.length} file(s) • Base ${e.baseCommitSha.slice(0, 7)}`,
						`Files:\n${e.files.join('\n')}\nCreated: ${e.createdAtIso}`
					)
			);
		}

		if (element.label?.toString().startsWith('Git Native Stashes')) {
			const stashes = await this.gitCli.listStashes(repo.rootPath);
			return stashes.map(
				s =>
					new ShelfOrStashTreeItem(
						s.ref,
						vscode.TreeItemCollapsibleState.None,
						'stashEntry',
						undefined,
						s,
						s.message,
						`${s.ref}: ${s.message}`
					)
			);
		}

		return [];
	}

	public dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
