import * as vscode from 'vscode';
import { GitCliService } from '../../core/gitCliService';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';

/**
 * Protected Branches Shield, Update Project (Ctrl+T), Push Dialog (Ctrl+Shift+K),
 * and Background Auto-Fetch Scheduler.
 */
export class ProtectedBranchGuard implements vscode.Disposable {
	private autoFetchTimer?: NodeJS.Timeout;

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly scmProvider: CommitProScmProvider
	) {
		this.setupAutoFetchTimer();
	}

	public getProtectedPatterns(): string[] {
		return vscode.workspace
			.getConfiguration('commitPro')
			.get<string[]>('protectedBranches', ['main', 'master', 'release/*']);
	}

	public isBranchProtected(branchName: string): boolean {
		return this.gitCli.matchesProtectedPattern(branchName, this.getProtectedPatterns());
	}

	public canRewriteHistory(branchName: string, operationName: string): boolean {
		if (this.isBranchProtected(branchName)) {
			vscode.window.showErrorMessage(
				`Protected Branch Shield: '${operationName}' is blocked on protected branch '${branchName}'.`
			);
			return false;
		}
		return true;
	}

	public async updateProjectInteractive(): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const strategyPick = await vscode.window.showQuickPick(
			[
				{
					label: '$(git-merge) Merge incoming changes into the current branch',
					id: 'merge' as const,
					description: 'git fetch && git pull --no-rebase',
					detail: 'Preserves branch history with a merge commit'
				},
				{
					label: '$(git-pull-request) Rebase the current branch on top of incoming changes',
					id: 'rebase' as const,
					description: 'git fetch && git pull --rebase',
					detail: 'Produces a clean linear commit history'
				},
				{
					label: '$(discard) Reset current branch to remote branch',
					id: 'reset' as const,
					description: `git fetch && git reset --hard origin/${repo.currentBranch}`,
					detail: 'Discards local unpushed commits and matches upstream exactly'
				}
			],
			{ placeHolder: `Update Project (${repo.name} — ${repo.currentBranch})` }
		);

		if (!strategyPick) {
			return;
		}

		await this.repoManager.executeAcrossTargetRepositories(
			repo.rootPath,
			`Update Project (${strategyPick.id})`,
			async rootPath => {
				const res = await this.gitCli.updateProject(rootPath, strategyPick.id);
				await this.scmProvider.refreshRepository(rootPath);
				if (res.exitCode !== 0) {
					const conflicts = this.scmProvider.getLatestChanges(rootPath).filter(c => c.isConflicted);
					if (conflicts.length > 0) {
						const resolveChoice = await vscode.window.showWarningMessage(
							`Update Project encountered ${conflicts.length} conflict(s). Open 3-Pane Conflict Resolver?`,
							'Open 3-Pane Resolver',
							'Later'
						);
						if (resolveChoice === 'Open 3-Pane Resolver') {
							await vscode.commands.executeCommand('commitPro.openThreeWayMerge', conflicts[0].uri);
						}
					}
				}
			}
		);

		vscode.window.showInformationMessage(`Updated project using '${strategyPick.id}' strategy.`);
	}

	public async pushInteractive(explicitRepoRoot?: string, upToCommitSha?: string): Promise<void> {
		const repo = explicitRepoRoot
			? this.repoManager.getRepositories().find(r => r.rootPath === explicitRepoRoot)
			: this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const isProtected = this.isBranchProtected(repo.currentBranch);
		const outgoingRange = repo.upstreamBranch ? `${repo.upstreamBranch}..HEAD` : 'HEAD';
		const outgoingCommits = await this.gitCli.getCommitLog(repo.rootPath, {
			branch: outgoingRange,
			maxCount: 15
		});

		const previewSummary =
			outgoingCommits.length > 0
				? `${outgoingCommits.length} outgoing commit(s) — latest: "${outgoingCommits[0].subject}"`
				: 'Push branch to remote';

		const options: {
			label: string;
			id: string;
			description: string;
			detail?: string;
		}[] = [
			{
				label: `$(cloud-upload) Push (${repo.currentBranch} → origin/${repo.currentBranch})`,
				id: 'push',
				description: previewSummary,
				detail: upToCommitSha ? `Push all commits up to ${upToCommitSha.slice(0, 7)}` : undefined
			},
			{
				label: '$(tag) Push with Follow-Tags (--follow-tags)',
				id: 'pushFollowTags',
				description: 'Push commits and annotated tags reachable from branch'
			},
			{
				label: '$(tag) Push with All Tags (--tags)',
				id: 'pushAllTags',
				description: 'Push commits and all local tags'
			}
		];

		if (isProtected) {
			options.push({
				label: '$(lock) Force Push (--force-with-lease) [DISABLED — Protected Branch]',
				id: 'blockedForce',
				description: `Branch '${repo.currentBranch}' is protected by Protected Branches Shield`
			});
		} else {
			options.push({
				label: '$(warning) Force Push (--force-with-lease)',
				id: 'forceWithLease',
				description: `Safely force push ${repo.currentBranch} with lease check`
			});
		}

		const choice = await vscode.window.showQuickPick(options, {
			placeHolder: `Push Commits from ${repo.name} (${repo.currentBranch})`
		});
		if (!choice) {
			return;
		}

		if (choice.id === 'blockedForce') {
			vscode.window.showErrorMessage(
				`Protected Branch Shield: Force Push to '${repo.currentBranch}' is strictly prohibited.`
			);
			return;
		}

		await this.gitCli.push(repo.rootPath, {
			remote: 'origin',
			branch: repo.currentBranch,
			upToCommitSha,
			forceWithLease: choice.id === 'forceWithLease',
			pushTags: choice.id === 'pushAllTags' ? 'all' : choice.id === 'pushFollowTags' ? 'follow' : 'none',
			setUpstream: !repo.upstreamBranch
		});

		await this.scmProvider.refreshRepository(repo.rootPath);
		vscode.window.showInformationMessage(`Pushed '${repo.currentBranch}' to origin.`);
	}

	private setupAutoFetchTimer(): void {
		const minutes = vscode.workspace
			.getConfiguration('commitPro')
			.get<number>('autoFetchIntervalMinutes', 20);
		if (minutes <= 0) {
			return;
		}

		const intervalMs = minutes * 60 * 1000;
		this.autoFetchTimer = setInterval(async () => {
			for (const repo of this.repoManager.getRepositories()) {
				try {
					await this.gitCli.fetchAll(repo.rootPath);
					await this.scmProvider.refreshRepository(repo.rootPath);
				} catch {
					// Silent background fetch
				}
			}
		}, intervalMs);
	}

	public dispose(): void {
		if (this.autoFetchTimer) {
			clearInterval(this.autoFetchTimer);
		}
	}
}
