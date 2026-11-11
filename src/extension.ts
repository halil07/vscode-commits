import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from './core/gitCliService';
import { RepositoryManager } from './modules/repository/repositoryManager';
import { WorktreeProvider, WorktreeTreeItem } from './modules/repository/worktreeProvider';
import { ChangelistStore } from './modules/changelist/changelistStore';
import { CommitProScmProvider, COMMIT_PRO_ORIG_SCHEME } from './modules/changelist/scmProvider';
import { PartialChunkService } from './modules/changelist/partialChunkService';
import { QualityGatesService } from './modules/commit/qualityGatesService';
import { CommitWorkflowService } from './modules/commit/commitWorkflowService';
import { CommitToolViewProvider } from './modules/commit/commitToolViewProvider';
import { BranchWidgetService } from './modules/branches/branchWidgetService';
import { ThreeWayMergePanel } from './modules/branches/threeWayMergePanel';
import { InteractiveRebasePanel } from './modules/branches/interactiveRebasePanel';
import { ProtectedBranchGuard } from './modules/audit/protectedBranchGuard';
import { ShelfManager, ShelfOrStashTreeItem } from './modules/audit/shelfManager';
import { BlameAnnotationController } from './modules/audit/blameAnnotationController';
import { GitLogViewProvider } from './modules/audit/gitLogViewProvider';

/**
 * Extension Entry Point (Composition Root).
 * Wires all CommitPro VCS modules using Clean Code Dependency Injection.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// 1. Core Infrastructure
	const gitCli = new GitCliService();
	const repoManager = new RepositoryManager(gitCli);
	const changelistStore = new ChangelistStore(context.workspaceState);
	const scmProvider = new CommitProScmProvider(gitCli, repoManager, changelistStore);
	const partialChunkService = new PartialChunkService(gitCli, repoManager, changelistStore, scmProvider);

	// 2. Audit, Protection & Shelf Layer
	const protectedBranchGuard = new ProtectedBranchGuard(gitCli, repoManager, scmProvider);
	const shelfManager = new ShelfManager(gitCli, repoManager, changelistStore, scmProvider);
	const blameController = new BlameAnnotationController(gitCli, repoManager);

	// 3. Commit Pipeline & Non-Modal Commit Tool Window (Alt+0)
	const qualityGates = new QualityGatesService();
	const commitWorkflow = new CommitWorkflowService(
		gitCli,
		repoManager,
		changelistStore,
		scmProvider,
		qualityGates,
		protectedBranchGuard
	);
	const commitToolView = new CommitToolViewProvider(
		gitCli,
		repoManager,
		changelistStore,
		scmProvider,
		commitWorkflow
	);

	// 4. Branch Widget, 3-Pane Conflict Resolver & Interactive Rebase Console
	const branchWidget = new BranchWidgetService(gitCli, repoManager, scmProvider, protectedBranchGuard);
	const threeWayMergePanel = new ThreeWayMergePanel(gitCli, repoManager, scmProvider);
	const interactiveRebasePanel = new InteractiveRebasePanel(
		gitCli,
		repoManager,
		scmProvider,
		protectedBranchGuard
	);

	// 5. Swimlane DAG Git Log & Console Tool Window (Alt+9) & Worktrees
	const gitLogView = new GitLogViewProvider(
		gitCli,
		repoManager,
		scmProvider,
		protectedBranchGuard,
		interactiveRebasePanel
	);
	const worktreeProvider = new WorktreeProvider(gitCli, repoManager);

	// Register Content Providers & the Commits Panel Webview View (`commitPro.logView`)
	context.subscriptions.push(
		gitCli,
		repoManager,
		changelistStore,
		scmProvider,
		protectedBranchGuard,
		shelfManager,
		blameController,
		commitToolView,
		branchWidget,
		gitLogView,
		worktreeProvider,
		vscode.workspace.registerTextDocumentContentProvider(COMMIT_PRO_ORIG_SCHEME, scmProvider),
		vscode.window.registerWebviewViewProvider(GitLogViewProvider.viewType, gitLogView)
	);

	// Register All Commands
	const register = (commandId: string, handler: (...args: never[]) => unknown) => {
		context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
	};

	register('commitPro.refresh', async () => {
		await repoManager.discoverRepositories();
		await scmProvider.syncAllRepositories();
		shelfManager.refresh();
		worktreeProvider.refresh();
	});

	register('commitPro.initRepository', () => repoManager.createGitRepositoryInteractive());
	register('commitPro.manageDirectoryMappings', () => repoManager.manageDirectoryMappingsInteractive());
	register('commitPro.manageRemotes', () => repoManager.manageRemotesInteractive());
	register('commitPro.addToGitignore', (res?: vscode.SourceControlResourceState | vscode.Uri) => {
		const uri = res && 'resourceUri' in res ? res.resourceUri : (res as vscode.Uri | undefined);
		return repoManager.addToGitignoreInteractive(uri);
	});

	// Changelist & Staging Commands
	register('commitPro.newChangelist', async () => {
		const repo = repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		const name = await vscode.window.showInputBox({
			prompt: 'New Changelist Name',
			placeHolder: 'e.g., Feature-Auth, Refactor-UI'
		});
		if (!name) {
			return;
		}
		const comment = await vscode.window.showInputBox({
			prompt: 'Optional default commit comment for this Changelist'
		});
		await changelistStore.createChangelist(repo.rootPath, name, comment || '', true);
	});

	register('commitPro.setActiveChangelist', async (group?: vscode.SourceControlResourceGroup) => {
		const repo = repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		if (group && group.id.startsWith('changelist:')) {
			const id = group.id.slice('changelist:'.length);
			await changelistStore.setActiveChangelist(repo.rootPath, id);
			return;
		}
		const lists = changelistStore.getChangelists(repo.rootPath);
		const picked = await vscode.window.showQuickPick(
			lists.map(l => ({
				label: `${l.isActive ? '$(check) ' : ''}${l.name}`,
				description: `${l.files.length} file(s)`,
				id: l.id
			})),
			{ placeHolder: 'Select Changelist to make Active' }
		);
		if (picked) {
			await changelistStore.setActiveChangelist(repo.rootPath, picked.id);
		}
	});

	register('commitPro.deleteChangelist', async (group?: vscode.SourceControlResourceGroup) => {
		const repo = repoManager.getActiveRepository();
		if (!repo) {
			return;
		}
		let targetId = group?.id?.startsWith('changelist:') ? group.id.slice('changelist:'.length) : undefined;
		if (!targetId) {
			const removable = changelistStore.getChangelists(repo.rootPath).filter(l => !l.isDefault);
			if (removable.length === 0) {
				vscode.window.showInformationMessage('No custom Changelists to delete.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				removable.map(l => ({ label: l.name, id: l.id })),
				{ placeHolder: 'Select Changelist to delete (files move to default Changes list)' }
			);
			targetId = picked?.id;
		}
		if (targetId) {
			await changelistStore.deleteChangelist(repo.rootPath, targetId);
		}
	});

	register('commitPro.moveToChangelist', (...states: vscode.SourceControlResourceState[]) =>
		partialChunkService.moveResourcesToChangelistInteractive(...states)
	);
	register('commitPro.toggleStagingMode', () => scmProvider.toggleStagingModeInteractive());

	register('commitPro.stageResource', async (...states: vscode.SourceControlResourceState[]) => {
		const uris = states.filter(s => s?.resourceUri).map(s => s.resourceUri);
		if (uris.length === 0 && vscode.window.activeTextEditor) {
			uris.push(vscode.window.activeTextEditor.document.uri);
		}
		if (uris.length === 0) {
			return;
		}
		const repo = repoManager.getRepositoryForUri(uris[0]);
		if (!repo) {
			return;
		}
		const relPaths = uris.map(u => path.relative(repo.rootPath, u.fsPath).replace(/\\/g, '/'));
		await gitCli.stageFiles(repo.rootPath, relPaths);
		await scmProvider.refreshRepository(repo.rootPath);
	});

	register('commitPro.unstageResource', async (...states: vscode.SourceControlResourceState[]) => {
		const uris = states.filter(s => s?.resourceUri).map(s => s.resourceUri);
		if (uris.length === 0 && vscode.window.activeTextEditor) {
			uris.push(vscode.window.activeTextEditor.document.uri);
		}
		if (uris.length === 0) {
			return;
		}
		const repo = repoManager.getRepositoryForUri(uris[0]);
		if (!repo) {
			return;
		}
		const relPaths = uris.map(u => path.relative(repo.rootPath, u.fsPath).replace(/\\/g, '/'));
		await gitCli.unstageFiles(repo.rootPath, relPaths);
		await scmProvider.refreshRepository(repo.rootPath);
	});

	register('commitPro.rollbackResource', async (...states: vscode.SourceControlResourceState[]) => {
		const uris = states.filter(s => s?.resourceUri).map(s => s.resourceUri);
		if (uris.length === 0 && vscode.window.activeTextEditor) {
			uris.push(vscode.window.activeTextEditor.document.uri);
		}
		if (uris.length === 0) {
			return;
		}
		const repo = repoManager.getRepositoryForUri(uris[0]);
		if (!repo) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Rollback local changes in ${uris.length} file(s)?`,
			{ modal: true },
			'Rollback',
			'Cancel'
		);
		if (confirm !== 'Rollback') {
			return;
		}
		const latestChanges = scmProvider.getLatestChanges(repo.rootPath);
		const tracked: string[] = [];
		const untracked: string[] = [];
		for (const u of uris) {
			const rel = path.relative(repo.rootPath, u.fsPath).replace(/\\/g, '/');
			const found = latestChanges.find(c => c.relativePath === rel);
			if (found?.isUntracked) {
				untracked.push(rel);
			} else {
				tracked.push(rel);
			}
		}
		await gitCli.discardFileChanges(repo.rootPath, tracked, untracked);
		await scmProvider.refreshRepository(repo.rootPath);
	});

	register('commitPro.rollbackSelectedLines', () => partialChunkService.rollbackSelectedLines());
	register('commitPro.stageSelectedLines', () => partialChunkService.stageSelectedLines());
	register('commitPro.openFileDiff', (res?: vscode.SourceControlResourceState | vscode.Uri) => {
		const uri = res && 'resourceUri' in res ? res.resourceUri : (res as vscode.Uri | undefined);
		return scmProvider.openFileDiff(uri);
	});

	// Commit & Push Commands
	register('commitPro.focusCommitWindow', async () => {
		await vscode.commands.executeCommand('commitPro.commitToolView.focus');
		commitToolView.focus();
	});
	register('commitPro.commit', (repoRoot?: string) => commitWorkflow.commitInteractive(false, repoRoot));
	register('commitPro.commitAndPush', (repoRoot?: string) => commitWorkflow.commitInteractive(true, repoRoot));
	register('commitPro.undoLastCommit', () => commitWorkflow.undoLastCommitInteractive());

	// Branches, Merge, Rebase & Remote Sync Commands
	register('commitPro.showBranchesPopup', () => branchWidget.showBranchesPopup());
	register('commitPro.updateProject', () => protectedBranchGuard.updateProjectInteractive());
	register('commitPro.fetch', async () => {
		const repos = repoManager.getRepositories();
		if (repos.length === 0) {
			return;
		}
		for (const repo of repos) {
			await gitCli.fetchAll(repo.rootPath);
			await scmProvider.refreshRepository(repo.rootPath);
		}
		vscode.window.showInformationMessage('Fetched all remotes.');
	});
	register('commitPro.push', () => protectedBranchGuard.pushInteractive());
	register('commitPro.openThreeWayMerge', (res?: vscode.SourceControlResourceState | vscode.Uri) => {
		const uri = res && 'resourceUri' in res ? res.resourceUri : (res as vscode.Uri | undefined);
		return threeWayMergePanel.openForFile(uri);
	});
	register('commitPro.interactiveRebase', (baseSha?: string) =>
		interactiveRebasePanel.openInteractiveRebase(baseSha)
	);

	// Audit, Blame, History, Shelf & Worktree Commands
	register('commitPro.focusLogWindow', async (branchFilter?: string, pathFilter?: string) => {
		await vscode.commands.executeCommand('commitPro.logView.focus');
		await gitLogView.focusWithFilter(branchFilter, pathFilter);
	});
	register('commitPro.toggleAnnotateBlame', () => blameController.toggleAnnotateBlame());
	register('commitPro.showFileHistory', (res?: vscode.SourceControlResourceState | vscode.Uri) => {
		const uri = res && 'resourceUri' in res ? res.resourceUri : (res as vscode.Uri | undefined);
		return blameController.showFileHistory(uri);
	});
	register('commitPro.showSelectionHistory', () => blameController.showSelectionHistory());
	register('commitPro.shelveChanges', (...states: vscode.SourceControlResourceState[]) =>
		shelfManager.shelveChangesInteractive(...states)
	);
	register('commitPro.unshelveChanges', (item?: ShelfOrStashTreeItem) =>
		shelfManager.unshelveChangesInteractive(item)
	);
	register('commitPro.deleteShelfEntry', (item?: ShelfOrStashTreeItem) =>
		shelfManager.deleteShelfEntry(item)
	);
	register('commitPro.stashChanges', () => shelfManager.stashChangesInteractive());
	register('commitPro.unstashChanges', (item?: ShelfOrStashTreeItem) =>
		shelfManager.unstashChangesInteractive(item)
	);
	register('commitPro.createWorktree', () => worktreeProvider.createWorktreeInteractive());
	register('commitPro.openWorktree', (item?: WorktreeTreeItem) => worktreeProvider.openWorktree(item));
	register('commitPro.deleteWorktree', (item?: WorktreeTreeItem) =>
		worktreeProvider.deleteWorktreeInteractive(item)
	);

	// Initial Discovery & SCM Sync
	await repoManager.discoverRepositories();
	await scmProvider.syncAllRepositories();
}

export function deactivate(): void {}
