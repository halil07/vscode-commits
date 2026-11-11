import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { GitCliService } from '../core/gitCliService';
import { RepositoryManager } from '../modules/repository/repositoryManager';
import { WorktreeProvider, WorktreeTreeItem } from '../modules/repository/worktreeProvider';
import { registeredCommands } from './__mocks__/vscode';
import { activate, deactivate } from '../extension';

vi.mock('fs/promises', () => ({
	access: vi.fn(async () => undefined),
	readdir: vi.fn(async () => []),
	readFile: vi.fn(async () => '.env.local\n# comment\nconfig/local.json'),
	writeFile: vi.fn(async () => undefined),
	mkdir: vi.fn(async () => undefined),
	copyFile: vi.fn(async () => undefined),
	rm: vi.fn(async () => undefined)
}));

describe('RepositoryManager, WorktreeProvider & Full Extension Command Suite', () => {
	let gitCli: GitCliService;
	let repoManager: RepositoryManager;
	let worktreeProvider: WorktreeProvider;

	beforeEach(() => {
		gitCli = new GitCliService();
		repoManager = new RepositoryManager(gitCli);
		worktreeProvider = new WorktreeProvider(gitCli, repoManager);

		vi.spyOn(gitCli, 'getRepositoryStatus').mockResolvedValue({
			branch: 'main',
			upstream: 'origin/main',
			ahead: 1,
			behind: 0,
			isDetached: false,
			changes: []
		});
		vi.spyOn(gitCli, 'getSubmodules').mockResolvedValue([
			{
				name: 'sub1',
				relativePath: 'libs/sub1',
				fullPath: '/workspace/repo/libs/sub1',
				sha: '12345678',
				branchOrTag: 'main',
				isDetached: false,
				isUninitialized: false
			}
		]);
		vi.spyOn(gitCli, 'getRemotes').mockResolvedValue([
			{ name: 'origin', fetchUrl: 'https://github.com/org/repo.git', pushUrl: 'https://github.com/org/repo.git' }
		]);
	});

	it('discovers repositories, builds tree items, and handles multi-root execution errors', async () => {
		await repoManager.discoverRepositories();
		const repos = repoManager.getRepositories();
		expect(repos.length).toBe(1);

		repoManager.setActiveRepository(repos[0].rootPath);
		const rootItems = await repoManager.getChildren();
		const childItems = await repoManager.getChildren(rootItems[0]);
		expect(childItems.length).toBe(2);
		expect(await repoManager.getChildren(childItems[0])).toEqual([]);

		await expect(
			repoManager.executeAcrossTargetRepositories(repos[0].rootPath, 'FailingOp', async () => {
				throw new Error('repo op failed');
			})
		).rejects.toThrow('repo op failed');
	});

	it('manages directory mappings (add/sync/remove), creates repos, adds 3-tier .gitignore rules, and manages remotes', async () => {
		await repoManager.discoverRepositories();
		vi.spyOn(gitCli, 'initRepository').mockResolvedValue(undefined);

		// 1. Add directory mapping where .git does not exist yet -> prompts git init
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Add',
			id: 'add'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([vscode.Uri.file('/ext-repo')]);
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('no .git'));
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Initialize (git init)' as unknown as vscode.MessageItem);
		await repoManager.manageDirectoryMappingsInteractive();

		// 2. Toggle sync
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Toggle Sync',
			id: 'sync'
		} as unknown as vscode.QuickPickItem);
		await repoManager.manageDirectoryMappingsInteractive();

		// 3. Remove mapping
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Remove',
			id: 'remove:/ext-repo'
		} as unknown as vscode.QuickPickItem);
		await repoManager.manageDirectoryMappingsInteractive();

		// 4. Create Git repository interactive
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([vscode.Uri.file('/new-repo')]);
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('no .gitignore'));
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Create .gitignore' as unknown as vscode.MessageItem);
		await repoManager.createGitRepositoryInteractive();

		// 5. Add to .gitignore across all 3 tiers (root, dir, exclude)
		vi.spyOn(gitCli, 'untrackFileKeepingWorkingCopy').mockResolvedValue(undefined);
		for (const tierId of ['root', 'dir', 'exclude']) {
			vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
				label: tierId,
				id: tierId
			} as unknown as vscode.QuickPickItem);
			vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('ignored.log');
			await repoManager.addToGitignoreInteractive(vscode.Uri.file('/workspace/repo/sub/ignored.log'));
		}

		// 6. Manage remotes interactive (add & remove)
		vi.spyOn(gitCli, 'addRemote').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'removeRemote').mockResolvedValue(undefined);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Add',
			id: 'add'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('upstream')
			.mockResolvedValueOnce('https://github.com/up/repo.git');
		await repoManager.manageRemotesInteractive();

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Remove origin',
			id: 'remote:origin'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as unknown as vscode.MessageItem);
		await repoManager.manageRemotesInteractive();
		expect(gitCli.removeRemote).toHaveBeenCalledWith(expect.any(String), 'origin');
		repoManager.dispose();
	});

	it('manages Git Worktrees: list, create, open, delete via item and via QuickPick', async () => {
		await repoManager.discoverRepositories();
		vi.spyOn(gitCli, 'listWorktrees').mockResolvedValue([
			{
				repoRoot: '/workspace/repo',
				worktreePath: '/workspace/repo',
				headSha: '11112222',
				branch: 'main',
				isBare: false,
				isMain: true,
				isDetached: false
			},
			{
				repoRoot: '/workspace/repo',
				worktreePath: '/workspace/repo-wt',
				headSha: '33334444',
				branch: 'feat-wt',
				isBare: false,
				isMain: false,
				isDetached: false
			}
		]);

		const items = await worktreeProvider.getChildren();
		expect(items.length).toBe(2);

		vi.spyOn(gitCli, 'getBranches').mockResolvedValue([]);
		vi.spyOn(gitCli, 'addWorktree').mockResolvedValue(undefined);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'HEAD (main)',
			branchName: 'main'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('feat-wt-new')
			.mockResolvedValueOnce('/workspace/repo-wt-new');
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Open in New Window' as unknown as vscode.MessageItem);

		await worktreeProvider.createWorktreeInteractive();
		await worktreeProvider.openWorktree(items[1]);
		await worktreeProvider.openWorktree(undefined);

		// Cannot delete main worktree
		await worktreeProvider.deleteWorktreeInteractive(items[0] as WorktreeTreeItem);

		// Delete via QuickPick when no item passed
		vi.spyOn(gitCli, 'removeWorktree').mockResolvedValue(undefined);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'feat-wt',
			wt: items[1].info
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Force Remove' as unknown as vscode.MessageItem);
		await worktreeProvider.deleteWorktreeInteractive();
		expect(gitCli.removeWorktree).toHaveBeenCalledWith('/workspace/repo', '/workspace/repo-wt', true);
		worktreeProvider.dispose();
	});

	it('executes all remaining commands registered in extension.ts', async () => {
		const subscriptions: { dispose: () => unknown }[] = [];
		const mockContext = {
			subscriptions,
			workspaceState: {
				keys: () => [],
				get: <T>(_k: string, def?: T): T => def as T,
				update: vi.fn(async () => undefined)
			}
		} as unknown as vscode.ExtensionContext;

		await activate(mockContext);

		// Set active editor so editor-fallback branches in extension.ts are covered
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
			document: {
				uri: vscode.Uri.file('/workspace/repo/a.ts'),
				getText: () => 'line1\n',
				lineCount: 1,
				save: vi.fn(async () => true)
			},
			selection: new vscode.Selection(0, 0, 0, 5),
			setDecorations: vi.fn()
		};

		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('New-CL')
			.mockResolvedValueOnce('Comment');
		await registeredCommands.get('commitPro.newChangelist')?.();

		// setActiveChangelist & deleteChangelist without group argument
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Changes',
			id: 'default-changes'
		} as unknown as vscode.QuickPickItem);
		await registeredCommands.get('commitPro.setActiveChangelist')?.();

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'New-CL',
			id: 'non-default'
		} as unknown as vscode.QuickPickItem);
		try {
			await registeredCommands.get('commitPro.deleteChangelist')?.();
		} catch {
			// Ignore
		}

		// rollbackResource with confirmation
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Rollback' as unknown as vscode.MessageItem);
		try {
			await registeredCommands.get('commitPro.rollbackResource')?.();
		} catch {
			// Ignore
		}

		for (const cmd of [
			'commitPro.stageResource',
			'commitPro.unstageResource',
			'commitPro.toggleStagingMode',
			'commitPro.openFileDiff',
			'commitPro.showFileHistory',
			'commitPro.openThreeWayMerge'
		]) {
			try {
				await registeredCommands.get(cmd)?.();
			} catch {
				// Ignore
			}
		}

		deactivate();
	});
});
