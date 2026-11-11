import * as vscode from 'vscode';
import { GitCliService } from '../../core/gitCliService';
import { GitBranchInfo } from '../../core/types';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { ProtectedBranchGuard } from '../audit/protectedBranchGuard';

interface BranchQuickPickItem extends vscode.QuickPickItem {
	readonly actionId?: string;
	readonly branch?: GitBranchInfo;
}

/**
 * Status Bar VCS Branch Widget & Hierarchical Branches Popup.
 * Tracks the 5 most recently checked-out branches and provides per-branch submenu actions:
 * Checkout, Checkout and Update, Compare with Current, Show Diff with Working Tree,
 * Rebase Current onto Selected, Merge into Current, Rename, and Safe Delete.
 */
export class BranchWidgetService implements vscode.Disposable {
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly recentBranchesByRepo = new Map<string, string[]>();

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly scmProvider: CommitProScmProvider,
		private readonly protectedGuard: ProtectedBranchGuard
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
		this.statusBarItem.command = 'commitPro.showBranchesPopup';
		this.repoManager.onDidChangeRepositories(() => this.updateStatusBar());
		this.scmProvider.onDidUpdateStatus(() => this.updateStatusBar());
		this.updateStatusBar();
	}

	public updateStatusBar(): void {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			this.statusBarItem.hide();
			return;
		}

		const incoming = repo.behind > 0 ? ` ↓${repo.behind}` : '';
		const outgoing = repo.ahead > 0 ? ` ↑${repo.ahead}` : '';
		const syncBadge =
			this.repoManager.isSynchronousBranchControlEnabled() && this.repoManager.getRepositories().length > 1
				? ' $(sync)'
				: '';

		this.statusBarItem.text = `$(git-branch) ${repo.currentBranch}${incoming}${outgoing}${syncBadge}`;
		this.statusBarItem.tooltip = new vscode.MarkdownString(
			`**CommitPro Branch Widget**\n\n` +
			`- **Repository:** ${repo.name}\n` +
			`- **Current Branch:** \`${repo.currentBranch}\`\n` +
			`- **Incoming / Outgoing:** ↓${repo.behind} / ↑${repo.ahead}\n` +
			`- **Multi-Root Sync:** ${this.repoManager.isSynchronousBranchControlEnabled() ? 'Enabled' : 'Disabled'}\n\n` +
			`*Click to open Branches Popup*`
		);
		this.statusBarItem.show();
	}

	public async showBranchesPopup(): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const protectedPatterns = this.protectedGuard.getProtectedPatterns();
		const branches = await this.gitCli.getBranches(repo.rootPath, protectedPatterns);
		const localBranches = branches.filter(b => !b.isRemote);
		const remoteBranches = branches.filter(b => b.isRemote);
		const recentNames = this.recentBranchesByRepo.get(repo.rootPath) ?? [];
		const recentBranches = recentNames
			.map(name => localBranches.find(b => b.name === name))
			.filter((b): b is GitBranchInfo => Boolean(b));

		const items: BranchQuickPickItem[] = [
			{ label: 'Top Actions', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(cloud-download) Update Project... (Ctrl+T)', actionId: 'updateProject', description: 'Fetch & Merge/Rebase incoming changes' },
			{ label: '$(git-commit) Commit...', actionId: 'commit', description: 'Open Commit Tool Window (Alt+0)' },
			{ label: '$(cloud-upload) Push... (Ctrl+Shift+K)', actionId: 'push', description: 'Preview & push outgoing commits' },
			{ label: '$(sync) Fetch All Remotes', actionId: 'fetch', description: 'Update remote tracking branches' },
			{ label: '$(add) New Branch...', actionId: 'newBranch', description: `Create branch from ${repo.currentBranch}` },
			{ label: '$(EmptyWindow) New Worktree...', actionId: 'newWorktree', description: 'Create isolated Git Worktree' }
		];

		if (recentBranches.length > 0) {
			items.push({ label: 'Recent Branches', kind: vscode.QuickPickItemKind.Separator });
			for (const b of recentBranches) {
				items.push(this.toBranchPickItem(b));
			}
		}

		items.push({ label: 'Local Branches', kind: vscode.QuickPickItemKind.Separator });
		for (const b of localBranches) {
			items.push(this.toBranchPickItem(b));
		}

		if (remoteBranches.length > 0) {
			items.push({ label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator });
			for (const b of remoteBranches) {
				items.push(this.toBranchPickItem(b));
			}
		}

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `Git Branches in ${repo.name} (Current: ${repo.currentBranch})`,
			matchOnDescription: true
		});

		if (!picked) {
			return;
		}

		if (picked.actionId) {
			switch (picked.actionId) {
				case 'updateProject':
					await vscode.commands.executeCommand('commitPro.updateProject');
					break;
				case 'commit':
					await vscode.commands.executeCommand('commitPro.focusCommitWindow');
					break;
				case 'push':
					await vscode.commands.executeCommand('commitPro.push');
					break;
				case 'fetch':
					await vscode.commands.executeCommand('commitPro.fetch');
					break;
				case 'newBranch':
					await this.createNewBranchInteractive(repo.rootPath, repo.currentBranch);
					break;
				case 'newWorktree':
					await vscode.commands.executeCommand('commitPro.createWorktree');
					break;
			}
			return;
		}

		if (picked.branch) {
			await this.showBranchSubmenu(repo.rootPath, repo.currentBranch, picked.branch);
		}
	}

	private toBranchPickItem(branch: GitBranchInfo): BranchQuickPickItem {
		const icon = branch.isCurrent
			? '$(star-full)'
			: branch.isRemote
				? '$(cloud)'
				: '$(git-branch)';
		const lockBadge = branch.isProtected ? ' 🔒' : '';
		const trackBadge =
			branch.ahead || branch.behind
				? ` (↑${branch.ahead} ↓${branch.behind})`
				: '';

		return {
			label: `${icon} ${branch.name}${lockBadge}${trackBadge}`,
			description: branch.upstream ? `→ ${branch.upstream}` : branch.lastCommitHash,
			detail: branch.lastCommitSubject,
			branch
		};
	}

	private async showBranchSubmenu(
		repoRoot: string,
		currentBranch: string,
		selected: GitBranchInfo
	): Promise<void> {
		const actions: { label: string; id: string; description?: string }[] = [
			{ label: '$(check) Checkout', id: 'checkout', description: `Switch to ${selected.name}` },
			{ label: '$(cloud-download) Checkout and Update', id: 'checkoutAndUpdate', description: 'Checkout & pull latest changes from upstream' },
			{ label: '$(add) New Branch from Selected...', id: 'newFromSelected', description: `Branch off ${selected.name}` },
			{ label: '$(diff) Compare with Current', id: 'compareWithCurrent', description: `View commits between ${currentBranch} and ${selected.name}` },
			{ label: '$(files) Show Diff with Working Tree', id: 'diffWorkingTree', description: `Diff uncommitted working tree against ${selected.name}` },
			{ label: '$(git-pull-request) Rebase Current onto Selected', id: 'rebaseOnto', description: `git rebase ${selected.name}` },
			{ label: '$(git-merge) Merge into Current', id: 'mergeIntoCurrent', description: `Merge ${selected.name} into ${currentBranch}` }
		];

		if (!selected.isRemote) {
			actions.push(
				{ label: '$(edit) Rename Branch...', id: 'rename' },
				{ label: '$(trash) Delete Branch...', id: 'delete' }
			);
		}

		const choice = await vscode.window.showQuickPick(actions, {
			placeHolder: `Branch '${selected.name}' Actions`
		});
		if (!choice) {
			return;
		}

		switch (choice.id) {
			case 'checkout': {
				const targetName = selected.isRemote ? selected.name.replace(/^[^/]+\//, '') : selected.name;
				await this.repoManager.executeAcrossTargetRepositories(repoRoot, `Checkout ${targetName}`, async root => {
					await this.gitCli.checkoutBranch(root, targetName, selected.isRemote, selected.isRemote ? selected.name : undefined);
				});
				this.recordRecentBranch(repoRoot, targetName);
				await this.scmProvider.refreshRepository(repoRoot);
				break;
			}

			case 'checkoutAndUpdate': {
				const targetName = selected.isRemote ? selected.name.replace(/^[^/]+\//, '') : selected.name;
				await this.gitCli.checkoutBranch(repoRoot, targetName, selected.isRemote, selected.isRemote ? selected.name : undefined);
				await this.gitCli.updateProject(repoRoot, 'merge');
				this.recordRecentBranch(repoRoot, targetName);
				await this.scmProvider.refreshRepository(repoRoot);
				vscode.window.showInformationMessage(`Checked out and updated '${targetName}'.`);
				break;
			}

			case 'newFromSelected':
				await this.createNewBranchInteractive(repoRoot, selected.name);
				break;

			case 'compareWithCurrent':
				await vscode.commands.executeCommand('commitPro.focusLogWindow', `${currentBranch}..${selected.name}`);
				break;

			case 'diffWorkingTree': {
				const { stdout } = await this.gitCli.execGit(repoRoot, ['diff', '--stat', selected.name], { allowNonZeroExit: true });
				vscode.window.showInformationMessage(
					stdout.trim()
						? `Diff summary vs ${selected.name}: ${stdout.trim().split('\n').pop()}`
						: `Working tree is identical to ${selected.name}.`
				);
				break;
			}

			case 'rebaseOnto': {
				if (!this.protectedGuard.canRewriteHistory(currentBranch, 'Rebase')) {
					return;
				}
				const res = await this.gitCli.rebaseBranch(repoRoot, selected.name);
				await this.scmProvider.refreshRepository(repoRoot);
				await this.handlePotentialConflicts(repoRoot, res.exitCode, `Rebase onto ${selected.name}`);
				break;
			}

			case 'mergeIntoCurrent': {
				const res = await this.gitCli.mergeBranch(repoRoot, selected.name);
				await this.scmProvider.refreshRepository(repoRoot);
				await this.handlePotentialConflicts(repoRoot, res.exitCode, `Merge ${selected.name} into ${currentBranch}`);
				break;
			}

			case 'rename': {
				const newName = await vscode.window.showInputBox({
					prompt: `Rename branch '${selected.name}' to:`,
					value: selected.name
				});
				if (newName && newName.trim() !== selected.name) {
					await this.gitCli.renameBranch(repoRoot, selected.name, newName.trim());
					await this.scmProvider.refreshRepository(repoRoot);
				}
				break;
			}

			case 'delete': {
				if (selected.isProtected) {
					vscode.window.showErrorMessage(`Cannot delete protected branch '${selected.name}'.`);
					return;
				}
				const confirm = await vscode.window.showWarningMessage(
					`Delete branch '${selected.name}'?`,
					'Safe Delete (-d)',
					'Force Delete (-D)',
					'Cancel'
				);
				if (confirm === 'Safe Delete (-d)' || confirm === 'Force Delete (-D)') {
					await this.gitCli.deleteBranch(repoRoot, selected.name, confirm === 'Force Delete (-D)');
					await this.scmProvider.refreshRepository(repoRoot);
				}
				break;
			}
		}
	}

	private async createNewBranchInteractive(repoRoot: string, startPoint: string): Promise<void> {
		const newBranch = await vscode.window.showInputBox({
			prompt: `Create and checkout new branch from '${startPoint}'`,
			placeHolder: 'feature/my-new-branch'
		});
		if (!newBranch) {
			return;
		}
		await this.repoManager.executeAcrossTargetRepositories(repoRoot, `Create branch ${newBranch}`, async root => {
			await this.gitCli.checkoutBranch(root, newBranch.trim(), true, startPoint);
		});
		this.recordRecentBranch(repoRoot, newBranch.trim());
		await this.scmProvider.refreshRepository(repoRoot);
	}

	private async handlePotentialConflicts(repoRoot: string, exitCode: number, operationLabel: string): Promise<void> {
		const changes = this.scmProvider.getLatestChanges(repoRoot);
		const conflicted = changes.filter(c => c.isConflicted);
		if (conflicted.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`${operationLabel} resulted in ${conflicted.length} conflicted file(s). Open 3-Pane Conflict Resolver?`,
				'Open 3-Pane Resolver',
				'Later'
			);
			if (choice === 'Open 3-Pane Resolver') {
				await vscode.commands.executeCommand('commitPro.openThreeWayMerge', conflicted[0].uri);
			}
		} else if (exitCode === 0) {
			vscode.window.showInformationMessage(`${operationLabel} completed cleanly.`);
		}
	}

	private recordRecentBranch(repoRoot: string, branchName: string): void {
		const list = this.recentBranchesByRepo.get(repoRoot) ?? [];
		const updated = [branchName, ...list.filter(b => b !== branchName)].slice(0, 5);
		this.recentBranchesByRepo.set(repoRoot, updated);
	}

	public dispose(): void {
		this.statusBarItem.dispose();
	}
}
