import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { GitCliService } from '../core/gitCliService';
import { RepositoryManager } from '../modules/repository/repositoryManager';
import { ChangelistStore } from '../modules/changelist/changelistStore';
import { CommitProScmProvider } from '../modules/changelist/scmProvider';
import { ProtectedBranchGuard } from '../modules/audit/protectedBranchGuard';
import { BranchWidgetService } from '../modules/branches/branchWidgetService';
import { ThreeWayMergePanel } from '../modules/branches/threeWayMergePanel';
import { InteractiveRebasePanel } from '../modules/branches/interactiveRebasePanel';

vi.mock('fs/promises', () => ({
	writeFile: vi.fn(async () => undefined),
	readFile: vi.fn(async () => ''),
	mkdtemp: vi.fn(async () => '/tmp/rebase-test'),
	rm: vi.fn(async () => undefined)
}));

describe('BranchWidgetService, ThreeWayMergePanel & InteractiveRebasePanel', () => {
	let gitCli: GitCliService;
	let repoManager: RepositoryManager;
	let changelistStore: ChangelistStore;
	let scmProvider: CommitProScmProvider;
	let protectedGuard: ProtectedBranchGuard;
	let branchWidget: BranchWidgetService;
	let mergePanel: ThreeWayMergePanel;
	let rebasePanel: InteractiveRebasePanel;

	beforeEach(() => {
		const mockMemento: vscode.Memento = {
			keys: () => [],
			get: <T>(_k: string, def?: T): T => def as T,
			update: vi.fn(async () => undefined)
		};

		gitCli = new GitCliService();
		repoManager = new RepositoryManager(gitCli);
		changelistStore = new ChangelistStore(mockMemento);
		scmProvider = new CommitProScmProvider(gitCli, repoManager, changelistStore);
		protectedGuard = new ProtectedBranchGuard(gitCli, repoManager, scmProvider);
		branchWidget = new BranchWidgetService(gitCli, repoManager, scmProvider, protectedGuard);
		mergePanel = new ThreeWayMergePanel(gitCli, repoManager, scmProvider);
		rebasePanel = new InteractiveRebasePanel(gitCli, repoManager, scmProvider, protectedGuard);

		vi.spyOn(repoManager, 'getRepositories').mockReturnValue([
			{
				rootPath: '/repo',
				rootUri: vscode.Uri.file('/repo'),
				name: 'repo',
				isExplicitMapping: false,
				isSubmodule: false,
				currentBranch: 'feature/dev',
				ahead: 1,
				behind: 2,
				isDetachedHead: false
			}
		]);
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValue(repoManager.getRepositories()[0]);
		vi.spyOn(repoManager, 'getRepositoryForUri').mockReturnValue(repoManager.getRepositories()[0]);
		vi.spyOn(scmProvider, 'refreshRepository').mockResolvedValue(undefined);
	});

	it('updates BranchWidgetService status bar and executes top-level and submenu branch actions', async () => {
		branchWidget.updateStatusBar();

		// When no active repo, hides status bar
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValueOnce(undefined);
		branchWidget.updateStatusBar();
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValueOnce(undefined);
		await branchWidget.showBranchesPopup();

		const sampleBranch = {
			name: 'develop',
			isCurrent: false,
			isRemote: false,
			upstream: 'origin/develop',
			ahead: 1,
			behind: 0,
			lastCommitHash: '1234567',
			lastCommitSubject: 'Dev commit',
			isProtected: false
		};
		const remoteBranch = {
			name: 'origin/develop',
			isCurrent: false,
			isRemote: true,
			remoteName: 'origin',
			ahead: 0,
			behind: 0,
			lastCommitHash: '1234567',
			lastCommitSubject: 'Remote commit',
			isProtected: false
		};
		const protectedBranch = {
			name: 'main',
			isCurrent: true,
			isRemote: false,
			ahead: 0,
			behind: 0,
			lastCommitHash: '1234567',
			lastCommitSubject: 'Main commit',
			isProtected: true
		};

		vi.spyOn(gitCli, 'getBranches').mockResolvedValue([sampleBranch, remoteBranch, protectedBranch]);
		vi.spyOn(gitCli, 'checkoutBranch').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'updateProject').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'mergeBranch').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'rebaseBranch').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'renameBranch').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'deleteBranch').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'execGit').mockResolvedValue({ stdout: '1 file changed\n', stderr: '', exitCode: 0 });
		vi.spyOn(repoManager, 'executeAcrossTargetRepositories').mockImplementation(async (_r, _op, fn) => {
			await fn('/repo');
		});

		// Top-level actions: updateProject, commit, push, fetch, newBranch, newWorktree
		for (const actionId of ['updateProject', 'commit', 'push', 'fetch', 'newWorktree']) {
			vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
				label: actionId,
				actionId
			} as unknown as vscode.QuickPickItem);
			await branchWidget.showBranchesPopup();
		}

		// Top-level newBranch
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'newBranch',
			actionId: 'newBranch'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('feature/created');
		await branchWidget.showBranchesPopup();

		// Submenu: checkout remote branch
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'origin/develop', branch: remoteBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Checkout', id: 'checkout' } as unknown as vscode.QuickPickItem);
		await branchWidget.showBranchesPopup();

		// Submenu: checkoutAndUpdate
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Checkout and Update', id: 'checkoutAndUpdate' } as unknown as vscode.QuickPickItem);
		await branchWidget.showBranchesPopup();

		// Submenu: newFromSelected, compareWithCurrent, diffWorkingTree
		for (const subId of ['newFromSelected', 'compareWithCurrent', 'diffWorkingTree']) {
			vi.mocked(vscode.window.showQuickPick)
				.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
				.mockResolvedValueOnce({ label: subId, id: subId } as unknown as vscode.QuickPickItem);
			if (subId === 'newFromSelected') {
				vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('feature/sub');
			}
			await branchWidget.showBranchesPopup();
		}

		// Submenu: rename
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Rename', id: 'rename' } as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('develop-renamed');
		await branchWidget.showBranchesPopup();
		expect(gitCli.renameBranch).toHaveBeenCalledWith('/repo', 'develop', 'develop-renamed');

		// Submenu: delete protected branch (blocked)
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'main', branch: protectedBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Delete', id: 'delete' } as unknown as vscode.QuickPickItem);
		await branchWidget.showBranchesPopup();

		// Submenu: merge with conflict prompt
		vi.spyOn(scmProvider, 'getLatestChanges').mockReturnValueOnce([
			{
				repoRoot: '/repo',
				relativePath: 'src/conflict.ts',
				uri: vscode.Uri.file('/repo/src/conflict.ts'),
				indexStatus: 'U',
				workTreeStatus: 'U',
				isConflicted: true,
				isUntracked: false,
				isStaged: false,
				isModifiedInWorkTree: true
			}
		]);
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Merge', id: 'mergeIntoCurrent' } as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open 3-Pane Resolver' as unknown as vscode.MessageItem);
		await branchWidget.showBranchesPopup();

		// Submenu: rebase & safe delete
		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Rebase', id: 'rebaseOnto' } as unknown as vscode.QuickPickItem);
		await branchWidget.showBranchesPopup();

		vi.mocked(vscode.window.showQuickPick)
			.mockResolvedValueOnce({ label: 'develop', branch: sampleBranch } as unknown as vscode.QuickPickItem)
			.mockResolvedValueOnce({ label: 'Delete', id: 'delete' } as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Force Delete (-D)' as unknown as vscode.MessageItem);
		await branchWidget.showBranchesPopup();
		expect(gitCli.deleteBranch).toHaveBeenCalledWith('/repo', 'develop', true);

		branchWidget.dispose();
	});

	it('opens ThreeWayMergePanel (both with URI and via conflict picker) and handles all resolution actions', async () => {
		vi.spyOn(gitCli, 'getConflictStages').mockResolvedValue({
			repoRoot: '/repo',
			relativePath: 'src/conflict.ts',
			baseContent: 'a = 1\nb = 2',
			yoursContent: 'a = 10\nb = 2',
			theirsContent: 'a = 1\nb = 20',
			workingCopyContent: '<<<<<<<\n'
		});
		vi.spyOn(gitCli, 'stageFiles').mockResolvedValue(undefined);

		// Without URI: picks from conflicted files list
		vi.spyOn(scmProvider, 'getLatestChanges').mockReturnValueOnce([
			{
				repoRoot: '/repo',
				relativePath: 'src/conflict.ts',
				uri: vscode.Uri.file('/repo/src/conflict.ts'),
				indexStatus: 'U',
				workTreeStatus: 'U',
				isConflicted: true,
				isUntracked: false,
				isStaged: false,
				isModifiedInWorkTree: true
			}
		]);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'src/conflict.ts',
			uri: vscode.Uri.file('/repo/src/conflict.ts')
		} as unknown as vscode.QuickPickItem);
		await mergePanel.openForFile();

		await mergePanel.openForFile(vscode.Uri.file('/repo/src/conflict.ts'));
		const createdPanel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value;
		expect(createdPanel).toBeDefined();

		createdPanel.webview._fireMessage({ type: 'ready' });
		createdPanel.webview._fireMessage({ type: 'magicWand' });
		createdPanel.webview._fireMessage({ type: 'resolveSimple' });
		createdPanel.webview._fireMessage({ type: 'resolveRegion', regionId: 1, side: 'yours' });
		createdPanel.webview._fireMessage({ type: 'resolveRegion', regionId: 1, side: 'theirs' });
		createdPanel.webview._fireMessage({ type: 'resolveRegion', regionId: 1, side: 'both' });
		createdPanel.webview._fireMessage({ type: 'resolveRegion', regionId: 1, side: 'ignore' });
		createdPanel.webview._fireMessage({ type: 'acceptAllYours' });
		createdPanel.webview._fireMessage({ type: 'acceptAllTheirs' });
		createdPanel.webview._fireMessage({ type: 'applyResult', mergedText: 'a = 10\nb = 20' });

		await new Promise(r => setTimeout(r, 20));
		expect(fs.writeFile).toHaveBeenCalled();
	});

	it('opens InteractiveRebasePanel (with and without explicit baseSha) and handles startRebase & cancel', async () => {
		vi.spyOn(gitCli, 'getCommitLog').mockResolvedValue([
			{
				hash: 'c2222222',
				shortHash: 'c222222',
				parents: ['c1111111'],
				authorName: 'Alice',
				authorEmail: 'alice@dev',
				authorDateIso: '2026-10-20T10:00:00Z',
				committerDateIso: '2026-10-20T10:00:00Z',
				subject: 'Second commit',
				refs: ['HEAD -> feature/dev']
			},
			{
				hash: 'c1111111',
				shortHash: 'c111111',
				parents: ['c0000000'],
				authorName: 'Alice',
				authorEmail: 'alice@dev',
				authorDateIso: '2026-10-19T10:00:00Z',
				committerDateIso: '2026-10-19T10:00:00Z',
				subject: 'First commit',
				refs: []
			}
		]);
		vi.spyOn(gitCli, 'execGit').mockResolvedValue({ stdout: 'rebased', stderr: '', exitCode: 0 });

		// Without baseSha: QuickPick
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'c111111',
			hash: 'c1111111'
		} as unknown as vscode.QuickPickItem);
		await rebasePanel.openInteractiveRebase();
		const panel1 = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value;
		panel1.webview._fireMessage({ type: 'cancel' });

		// With baseSha: startRebase
		await rebasePanel.openInteractiveRebase('c1111111');
		const panel2 = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value;
		panel2.webview._fireMessage({
			type: 'startRebase',
			entries: [
				{
					hash: 'c1111111',
					shortHash: 'c111111',
					author: 'Alice',
					dateIso: '2026-10-19',
					subject: 'First commit',
					action: 'pick'
				},
				{
					hash: 'c2222222',
					shortHash: 'c222222',
					author: 'Alice',
					dateIso: '2026-10-20',
					subject: 'Second commit',
					action: 'squash'
				}
			]
		});

		await new Promise(r => setTimeout(r, 20));
		expect(gitCli.execGit).toHaveBeenCalled();
	});
});
