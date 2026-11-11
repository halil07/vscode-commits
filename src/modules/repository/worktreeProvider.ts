import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GitCliService } from '../../core/gitCliService';
import { RepositoryManager } from './repositoryManager';
import { WorktreeInfo } from '../../core/types';

export class WorktreeTreeItem extends vscode.TreeItem {
	constructor(public readonly info: WorktreeInfo) {
		super(path.basename(info.worktreePath), vscode.TreeItemCollapsibleState.None);
		this.description = `${info.branch} (${info.headSha})${info.isMain ? ' [Main]' : ''}`;
		this.tooltip = `Path: ${info.worktreePath}\nBranch: ${info.branch}\nHEAD: ${info.headSha}`;
		this.contextValue = 'worktreeItem';
		this.iconPath = new vscode.ThemeIcon(info.isMain ? 'repo' : 'worktree');
	}
}

/**
 * Git Worktree Registry & Lifecycle Manager.
 * Supports creating isolated worktrees, automatically copying untracked files
 * specified in `.worktreeinclude` (such as `.env.local`), and opening worktrees in VS Code.
 */
export class WorktreeProvider implements vscode.TreeDataProvider<WorktreeTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorktreeTreeItem | undefined | void>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager
	) {
		this.repoManager.onDidChangeRepositories(() => this.refresh());
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	public getTreeItem(element: WorktreeTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(): Promise<WorktreeTreeItem[]> {
		const items: WorktreeTreeItem[] = [];
		for (const repo of this.repoManager.getRepositories()) {
			const worktrees = await this.gitCli.listWorktrees(repo.rootPath);
			for (const wt of worktrees) {
				items.push(new WorktreeTreeItem(wt));
			}
		}
		return items;
	}

	public async createWorktreeInteractive(): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const protectedPatterns = vscode.workspace
			.getConfiguration('commitPro')
			.get<string[]>('protectedBranches', ['main', 'master', 'release/*']);
		const branches = await this.gitCli.getBranches(repo.rootPath, protectedPatterns);

		const startPointPick = await vscode.window.showQuickPick(
			[
				{ label: `HEAD (${repo.currentBranch})`, branchName: repo.currentBranch, isCurrent: true },
				...branches.map(b => ({
					label: `${b.isRemote ? '$(cloud) ' : '$(git-branch) '}${b.name}`,
					description: b.lastCommitSubject,
					branchName: b.name,
					isCurrent: b.isCurrent
				}))
			],
			{ placeHolder: 'Select base branch or revision for the new Git Worktree' }
		);
		if (!startPointPick) {
			return;
		}

		const suggestedBranch = startPointPick.branchName.replace(/^origin\//, '') + '-worktree';
		const newBranchName = await vscode.window.showInputBox({
			prompt: 'New branch name for the isolated Worktree',
			value: suggestedBranch
		});
		if (!newBranchName) {
			return;
		}

		const parentDir = path.dirname(repo.rootPath);
		const defaultTargetDir = path.join(parentDir, `${repo.name}-${newBranchName.replace(/[^a-zA-Z0-9-_]/g, '-')}`);
		const targetPath = await vscode.window.showInputBox({
			prompt: 'Target directory path for the new Git Worktree',
			value: defaultTargetDir
		});
		if (!targetPath) {
			return;
		}

		await this.gitCli.addWorktree(repo.rootPath, targetPath, newBranchName, startPointPick.branchName);
		const copiedFiles = await this.copyWorktreeIncludeFiles(repo.rootPath, targetPath);

		this.refresh();

		const openChoice = await vscode.window.showInformationMessage(
			`Created Worktree at '${targetPath}'${copiedFiles.length > 0 ? ` (copied ${copiedFiles.length} .worktreeinclude file(s))` : ''}. Open in a new window?`,
			'Open in New Window',
			'Stay Here'
		);
		if (openChoice === 'Open in New Window') {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetPath), true);
		}
	}

	private async copyWorktreeIncludeFiles(sourceRepoRoot: string, targetWorktreePath: string): Promise<string[]> {
		const includeFilePath = path.join(sourceRepoRoot, '.worktreeinclude');
		const copied: string[] = [];
		const candidates = new Set<string>(['.env.local']);

		try {
			const content = await fs.readFile(includeFilePath, 'utf8');
			for (const rawLine of content.split(/\r?\n/)) {
				const line = rawLine.trim();
				if (line && !line.startsWith('#')) {
					candidates.add(line);
				}
			}
		} catch {
			// No .worktreeinclude file present; still check default .env.local
		}

		for (const relFile of candidates) {
			const srcFull = path.join(sourceRepoRoot, relFile);
			const destFull = path.join(targetWorktreePath, relFile);
			try {
				await fs.access(srcFull);
				await fs.mkdir(path.dirname(destFull), { recursive: true });
				await fs.copyFile(srcFull, destFull);
				copied.push(relFile);
			} catch {
				// Candidate file does not exist in source repo; skip
			}
		}

		return copied;
	}

	public async openWorktree(item?: WorktreeTreeItem): Promise<void> {
		if (!item) {
			return;
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(item.info.worktreePath), true);
	}

	public async deleteWorktreeInteractive(item?: WorktreeTreeItem): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		let target = item?.info;
		if (!target) {
			const all = await this.gitCli.listWorktrees(repo.rootPath);
			const nonMain = all.filter(w => !w.isMain);
			if (nonMain.length === 0) {
				vscode.window.showInformationMessage('No secondary worktrees to remove.');
				return;
			}
			const pick = await vscode.window.showQuickPick(
				nonMain.map(w => ({ label: w.branch, description: w.worktreePath, wt: w })),
				{ placeHolder: 'Select Git Worktree to remove' }
			);
			target = pick?.wt;
		}

		if (!target || target.isMain) {
			vscode.window.showWarningMessage('Cannot remove the main repository worktree.');
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			`Remove worktree '${target.worktreePath}' (${target.branch})?`,
			'Remove',
			'Force Remove',
			'Cancel'
		);
		if (!confirm || confirm === 'Cancel') {
			return;
		}

		await this.gitCli.removeWorktree(target.repoRoot, target.worktreePath, confirm === 'Force Remove');
		this.refresh();
		vscode.window.showInformationMessage(`Removed worktree '${target.worktreePath}'.`);
	}

	public dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
