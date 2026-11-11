import * as vscode from 'vscode';
import { GitCliService } from '../../core/gitCliService';
import { CommitOptions } from '../../core/types';
import { ChangelistStore } from '../changelist/changelistStore';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { ProtectedBranchGuard } from '../audit/protectedBranchGuard';
import { QualityGatesService } from './qualityGatesService';

/**
 * Commit & Commit-and-Push Pipeline Service.
 * Orchestrates Changelist-scoped commits, Pre-Commit Quality Gates, Amend, Sign-off,
 * GPG signing, Author override, and Undo Last Commit.
 */
export class CommitWorkflowService {
	private readonly recentCommitMessages: string[] = [];

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly changelistStore: ChangelistStore,
		private readonly scmProvider: CommitProScmProvider,
		private readonly qualityGates: QualityGatesService,
		private readonly protectedBranchGuard: ProtectedBranchGuard
	) {}

	public getRecentCommitMessages(): readonly string[] {
		return this.recentCommitMessages;
	}

	public async executeCommit(
		repoRoot: string,
		options: CommitOptions,
		selectedFiles?: string[]
	): Promise<boolean> {
		if (!options.message.trim()) {
			vscode.window.showWarningMessage('Please enter a commit message before committing.');
			return false;
		}

		if (options.amend) {
			const repo = this.repoManager.getRepositories().find(r => r.rootPath === repoRoot);
			if (repo && !this.protectedBranchGuard.canRewriteHistory(repo.currentBranch, 'Amend Commit')) {
				return false;
			}
		}

		let filesToCommit = selectedFiles;
		if (!filesToCommit || filesToCommit.length === 0) {
			const mode = this.scmProvider.getStagingMode();
			if (mode === 'changelist') {
				const activeList = this.changelistStore.getActiveChangelist(repoRoot);
				filesToCommit = [...activeList.files];
			} else {
				const changes = this.scmProvider.getLatestChanges(repoRoot);
				const staged = changes.filter(c => c.isStaged).map(c => c.relativePath);
				filesToCommit = staged.length > 0 ? staged : changes.filter(c => !c.isUntracked).map(c => c.relativePath);
			}
		}

		if (filesToCommit.length === 0 && !options.amend) {
			vscode.window.showWarningMessage('No modified files selected in the active Changelist / Index to commit.');
			return false;
		}

		const gateCheck = await this.qualityGates.runPreCommitQualityGates(repoRoot, filesToCommit, options);
		if (!gateCheck.proceed) {
			return false;
		}

		try {
			await this.gitCli.commit(repoRoot, options, filesToCommit);
			this.recordCommitMessage(options.message.trim());
			this.scmProvider.setInputBoxValue(repoRoot, '');
			await this.scmProvider.refreshRepository(repoRoot);

			if (options.pushAfterCommit) {
				await this.protectedBranchGuard.pushInteractive(repoRoot);
			} else {
				vscode.window.showInformationMessage(
					`Committed ${filesToCommit.length} file(s) (${options.message.split('\n')[0]}).`
				);
			}
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Commit failed: ${msg}`);
			return false;
		}
	}

	public async commitInteractive(pushAfterCommit = false, explicitRepoRoot?: string): Promise<void> {
		const repo = explicitRepoRoot
			? this.repoManager.getRepositories().find(r => r.rootPath === explicitRepoRoot)
			: this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		let message = this.scmProvider.getInputBoxValue(repo.rootPath).trim();
		if (!message) {
			const lastMsg = await this.gitCli.getLastCommitMessage(repo.rootPath);
			const input = await vscode.window.showInputBox({
				prompt: `Commit message for ${repo.name} (${this.changelistStore.getActiveChangelist(repo.rootPath).name})`,
				placeHolder: 'feat(scope): summary (72 chars max recommended)',
				value: lastMsg ? '' : undefined
			});
			if (!input) {
				return;
			}
			message = input;
		}

		const config = vscode.workspace.getConfiguration('commitPro.qualityGates');
		const options: CommitOptions = {
			message,
			amend: false,
			signOff: false,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: config.get<boolean>('reformatCode', false),
			optimizeImports: config.get<boolean>('optimizeImports', false),
			analyzeCode: config.get<boolean>('analyzeCode', true),
			checkTodo: config.get<boolean>('checkTodo', true),
			pushAfterCommit
		};

		await this.executeCommit(repo.rootPath, options);
	}

	public async undoLastCommitInteractive(): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		if (!this.protectedBranchGuard.canRewriteHistory(repo.currentBranch, 'Undo Last Commit')) {
			return;
		}

		const lastMessage = await this.gitCli.getLastCommitMessage(repo.rootPath);
		const confirm = await vscode.window.showWarningMessage(
			`Undo last commit ("${lastMessage.split('\n')[0]}") and keep changes in active Changelist?`,
			'Undo Commit',
			'Cancel'
		);
		if (confirm !== 'Undo Commit') {
			return;
		}

		await this.gitCli.undoLastCommit(repo.rootPath);
		if (lastMessage) {
			this.scmProvider.setInputBoxValue(repo.rootPath, lastMessage);
		}
		await this.scmProvider.refreshRepository(repo.rootPath);
		vscode.window.showInformationMessage('Undid last commit. Changes restored to active Changelist.');
	}

	private recordCommitMessage(message: string): void {
		if (!this.recentCommitMessages.includes(message)) {
			this.recentCommitMessages.unshift(message);
			if (this.recentCommitMessages.length > 25) {
				this.recentCommitMessages.pop();
			}
		}
	}
}
