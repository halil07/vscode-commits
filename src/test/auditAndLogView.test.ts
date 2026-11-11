import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { GitCliService } from '../core/gitCliService';
import { RepositoryManager } from '../modules/repository/repositoryManager';
import { ChangelistStore } from '../modules/changelist/changelistStore';
import { CommitProScmProvider } from '../modules/changelist/scmProvider';
import { ProtectedBranchGuard } from '../modules/audit/protectedBranchGuard';
import { ShelfManager, ShelfOrStashTreeItem } from '../modules/audit/shelfManager';
import { BlameAnnotationController } from '../modules/audit/blameAnnotationController';
import { GitLogViewProvider } from '../modules/audit/gitLogViewProvider';
import { InteractiveRebasePanel } from '../modules/branches/interactiveRebasePanel';
import { activate, deactivate } from '../extension';
import { registeredCommands } from './__mocks__/vscode';

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async () =>
		JSON.stringify([
			{
				id: 'shelf-1',
				name: 'WIP Shelf',
				createdAtIso: '2026-10-20T10:00:00Z',
				repoRoot: '/repo',
				baseCommitSha: 'abcdef123456',
				patchFilePath: '/repo/.vscode/commit-pro/shelf/shelf-1.patch',
				files: ['src/a.ts']
			}
		])
	),
	writeFile: vi.fn(async () => undefined),
	mkdir: vi.fn(async () => undefined),
	rm: vi.fn(async () => undefined),
	access: vi.fn(async () => undefined),
	readdir: vi.fn(async () => [])
}));

describe('ProtectedBranchGuard, ShelfManager, BlameAnnotationController, GitLogViewProvider & Extension', () => {
	let gitCli: GitCliService;
	let repoManager: RepositoryManager;
	let changelistStore: ChangelistStore;
	let scmProvider: CommitProScmProvider;
	let protectedGuard: ProtectedBranchGuard;
	let shelfManager: ShelfManager;
	let blameController: BlameAnnotationController;
	let rebasePanel: InteractiveRebasePanel;
	let logViewProvider: GitLogViewProvider;

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
		shelfManager = new ShelfManager(gitCli, repoManager, changelistStore, scmProvider);
		blameController = new BlameAnnotationController(gitCli, repoManager);
		rebasePanel = new InteractiveRebasePanel(gitCli, repoManager, scmProvider, protectedGuard);
		logViewProvider = new GitLogViewProvider(gitCli, repoManager, scmProvider, protectedGuard, rebasePanel);

		vi.spyOn(repoManager, 'getRepositories').mockReturnValue([
			{
				rootPath: '/repo',
				rootUri: vscode.Uri.file('/repo'),
				name: 'repo',
				isExplicitMapping: false,
				isSubmodule: false,
				currentBranch: 'feature/work',
				ahead: 1,
				behind: 0,
				isDetachedHead: false
			}
		]);
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValue(repoManager.getRepositories()[0]);
		vi.spyOn(repoManager, 'getRepositoryForUri').mockReturnValue(repoManager.getRepositories()[0]);
		vi.spyOn(scmProvider, 'refreshRepository').mockResolvedValue(undefined);
	});

	it('enforces ProtectedBranchGuard rules and runs updateProjectInteractive & pushInteractive', async () => {
		expect(protectedGuard.isBranchProtected('main')).toBe(true);
		expect(protectedGuard.isBranchProtected('release/1.0')).toBe(true);
		expect(protectedGuard.isBranchProtected('feature/work')).toBe(false);

		expect(protectedGuard.canRewriteHistory('main', 'Force Push')).toBe(false);
		expect(protectedGuard.canRewriteHistory('feature/work', 'Rebase')).toBe(true);

		vi.spyOn(repoManager, 'executeAcrossTargetRepositories').mockImplementation(async (_r, _op, fn) => {
			await fn('/repo');
		});
		vi.spyOn(gitCli, 'updateProject').mockResolvedValue({ stdout: '', stderr: 'conflict', exitCode: 1 });
		vi.spyOn(scmProvider, 'getLatestChanges').mockReturnValueOnce([
			{
				repoRoot: '/repo',
				relativePath: 'src/c.ts',
				uri: vscode.Uri.file('/repo/src/c.ts'),
				indexStatus: 'U',
				workTreeStatus: 'U',
				isConflicted: true,
				isUntracked: false,
				isStaged: false,
				isModifiedInWorkTree: true
			}
		]);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Rebase',
			id: 'rebase'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open 3-Pane Resolver' as unknown as vscode.MessageItem);
		await protectedGuard.updateProjectInteractive();

		vi.spyOn(gitCli, 'getCommitLog').mockResolvedValue([]);
		vi.spyOn(gitCli, 'push').mockResolvedValue(undefined);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Force Push Blocked',
			id: 'blockedForce'
		} as unknown as vscode.QuickPickItem);
		await protectedGuard.pushInteractive('/repo', 'abcdef1');

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Force Push',
			id: 'forceWithLease'
		} as unknown as vscode.QuickPickItem);
		await protectedGuard.pushInteractive('/repo', 'abcdef1');

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Push Follow Tags',
			id: 'pushFollowTags'
		} as unknown as vscode.QuickPickItem);
		await protectedGuard.pushInteractive('/repo');

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Push All Tags',
			id: 'pushAllTags'
		} as unknown as vscode.QuickPickItem);
		await protectedGuard.pushInteractive('/repo');

		// Protected branch push options
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValueOnce({
			rootPath: '/repo',
			rootUri: vscode.Uri.file('/repo'),
			name: 'repo',
			isExplicitMapping: false,
			isSubmodule: false,
			currentBranch: 'main',
			upstreamBranch: 'origin/main',
			ahead: 1,
			behind: 0,
			isDetachedHead: false
		});
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
		await protectedGuard.pushInteractive();

		expect(gitCli.push).toHaveBeenCalled();
		protectedGuard.dispose();
	});

	it('manages Shelf & Stash entries: shelve, unshelve (with QuickPick & conflicts), delete, stash, unstash', async () => {
		vi.spyOn(gitCli, 'createDiffPatch').mockResolvedValue('diff --git a/src/a.ts b/src/a.ts');
		vi.spyOn(gitCli, 'execGit').mockResolvedValue({ stdout: 'abcdef123456\n', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'discardFileChanges').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'applyPatchFile').mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
		vi.spyOn(gitCli, 'createStash').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'listStashes').mockResolvedValue([
			{ index: 0, ref: 'stash@{0}', branch: 'main', message: 'WIP', repoRoot: '/repo' }
		]);
		vi.spyOn(gitCli, 'popStash').mockResolvedValue(undefined);

		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('My Shelf Patch');
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Shelve and Rollback',
			remove: true
		} as unknown as vscode.QuickPickItem);

		await shelfManager.shelveChangesInteractive({
			resourceUri: vscode.Uri.file('/repo/src/a.ts')
		});

		const rootSections = await shelfManager.getChildren();
		const shelfItems = await shelfManager.getChildren(rootSections[0]);
		const stashItems = await shelfManager.getChildren(rootSections[1]);
		expect(stashItems.length).toBe(1);
		expect(shelfManager.getTreeItem(shelfItems[0])).toBe(shelfItems[0]);

		// Unshelve without item argument (uses QuickPick) and triggers conflict warning
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'WIP Shelf',
			entry: (shelfItems[0] as ShelfOrStashTreeItem).shelfEntry
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open 3-Pane Resolver' as unknown as vscode.MessageItem);
		await shelfManager.unshelveChangesInteractive();

		await shelfManager.deleteShelfEntry(shelfItems[0] as ShelfOrStashTreeItem);

		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('WIP Stash');
		await shelfManager.stashChangesInteractive();

		// Unstash without item argument (uses QuickPick)
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'stash@{0}'
		} as unknown as vscode.QuickPickItem);
		await shelfManager.unstashChangesInteractive();

		// Empty shelf & empty stash & shelve without resourceStates
		await shelfManager.shelveChangesInteractive();
		vi.spyOn(shelfManager, 'listShelfEntries').mockResolvedValueOnce([]);
		await shelfManager.unshelveChangesInteractive();
		vi.spyOn(gitCli, 'listStashes').mockResolvedValueOnce([]);
		await shelfManager.unstashChangesInteractive();

		shelfManager.dispose();
	});

	it('toggles Git Blame annotations, shows file history, and shows selection history', async () => {
		const setDecorations = vi.fn();
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
			document: {
				uri: vscode.Uri.file('/repo/src/a.ts'),
				getText: () => 'line1\nline2\n',
				lineCount: 2,
				save: vi.fn(async () => true)
			},
			selection: new vscode.Selection(0, 0, 1, 5),
			setDecorations
		};

		vi.spyOn(gitCli, 'getFileBlame').mockResolvedValue([
			{
				lineNumber: 1,
				hash: '0123456789abcdef0123456789abcdef01234567',
				shortHash: '0123456',
				author: 'Alice',
				authorEmail: '<alice@dev>',
				authorTimestampSec: 1700000000,
				summary: 'Initial commit'
			}
		]);
		vi.spyOn(gitCli, 'getSelectionHistory').mockResolvedValue('commit 0123456\nAuthor: Alice\n');

		await blameController.toggleAnnotateBlame();
		await blameController.toggleAnnotateBlame();

		await blameController.showFileHistory(vscode.Uri.file('/repo/src/a.ts'));
		await blameController.showSelectionHistory();

		// Empty blame and empty selection history paths
		vi.spyOn(gitCli, 'getFileBlame').mockResolvedValueOnce([]);
		await blameController.toggleAnnotateBlame();
		vi.spyOn(gitCli, 'getSelectionHistory').mockResolvedValueOnce('   ');
		await blameController.showSelectionHistory();

		// Missing activeTextEditor paths
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
		await blameController.toggleAnnotateBlame();
		await blameController.showFileHistory();
		await blameController.showSelectionHistory();

		blameController.dispose();
	});

	it('resolves GitLogViewProvider (Commits Panel) and executes all commit & file context menu actions', async () => {
		const msgEmitter = new vscode.EventEmitter<unknown>();
		const postMessage = vi.fn(async () => true);
		const mockWebviewView = {
			webview: {
				cspSource: 'vscode-webview:',
				options: {},
				html: '',
				postMessage,
				onDidReceiveMessage: msgEmitter.event
			},
			show: vi.fn()
		} as unknown as vscode.WebviewView;

		vi.spyOn(gitCli, 'getCommitLog').mockResolvedValue([
			{
				hash: '1111222233334444555566667777888899990000',
				shortHash: '1111222',
				parents: [],
				authorName: 'Alice',
				authorEmail: 'alice@dev',
				authorDateIso: '2026-10-20T10:00:00Z',
				committerDateIso: '2026-10-20T10:00:00Z',
				subject: 'feat: initial',
				refs: ['HEAD -> feature/work']
			}
		]);
		vi.spyOn(gitCli, 'getBranches').mockResolvedValue([
			{
				name: 'feature/work',
				isCurrent: true,
				isRemote: false,
				ahead: 0,
				behind: 0,
				lastCommitHash: '1111222',
				lastCommitSubject: 'feat: initial',
				isProtected: false
			}
		]);
		vi.spyOn(gitCli, 'getCommitChangedFiles').mockResolvedValue([{ status: 'M', relativePath: 'src/a.ts' }]);
		vi.spyOn(gitCli, 'getCommitMessage').mockResolvedValue('feat: initial');
		vi.spyOn(gitCli, 'showFileAtRevision').mockResolvedValue('file-content');
		vi.spyOn(gitCli, 'checkoutBranch').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'cherryPick').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'getHeadCommitHash').mockResolvedValue('1111222233334444555566667777888899990000');
		vi.spyOn(gitCli, 'rewordHeadCommit').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'revertCommit').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'undoLastCommit').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'dropSingleCommit').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		vi.spyOn(gitCli, 'resetBranch').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'createTag').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'showFullCommit').mockResolvedValue('full-diff');
		vi.spyOn(gitCli, 'formatCommitPatch').mockResolvedValue('patch-text');
		vi.spyOn(gitCli, 'restoreFileAtRevision').mockResolvedValue(undefined);
		vi.spyOn(protectedGuard, 'pushInteractive').mockResolvedValue(undefined);

		logViewProvider.resolveWebviewView(mockWebviewView);
		await logViewProvider.focusWithFilter('feature/work', 'src/a.ts');

		const sha = '1111222233334444555566667777888899990000';
		msgEmitter.fire({ type: 'applyFilter', branch: 'ALL', searchPattern: 'feat' });
		msgEmitter.fire({ type: 'selectCommit', hash: sha, subject: 'feat: initial' });
		msgEmitter.fire({ type: 'openCommitFileDiff', hash: sha, relativePath: 'src/a.ts' });
		msgEmitter.fire({ type: 'toolbarGitAction', command: 'fetch' });
		msgEmitter.fire({ type: 'toolbarGitAction', command: 'pull' });
		msgEmitter.fire({ type: 'toolbarGitAction', command: 'push' });
		msgEmitter.fire({ type: 'toolbarGitAction', command: 'branches' });

		for (const act of ['diffCommit', 'compareWithLocal', 'openRevision', 'openLocalFile', 'fileHistory', 'copyPath']) {
			msgEmitter.fire({ type: 'fileAction', action: act, hash: sha, relativePath: 'src/a.ts' });
		}
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Restore File' as unknown as vscode.MessageItem);
		msgEmitter.fire({ type: 'fileAction', action: 'restoreFile', hash: sha, relativePath: 'src/a.ts' });

		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Checkout Revision' as unknown as vscode.MessageItem);
		msgEmitter.fire({ type: 'commitAction', action: 'checkoutRevision', hash: sha });

		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('feature/from-commit');
		msgEmitter.fire({ type: 'commitAction', action: 'newBranchFromCommit', hash: sha });

		msgEmitter.fire({ type: 'commitAction', action: 'cherryPick', hash: sha });

		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('feat: reworded message');
		msgEmitter.fire({ type: 'commitAction', action: 'rewordCommit', hash: sha });

		msgEmitter.fire({ type: 'commitAction', action: 'revert', hash: sha });
		msgEmitter.fire({ type: 'commitAction', action: 'undoCommit', hash: sha });

		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Drop Commit' as unknown as vscode.MessageItem);
		msgEmitter.fire({ type: 'commitAction', action: 'dropCommit', hash: sha, subject: 'feat: initial' });

		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Soft',
			mode: 'soft'
		} as unknown as vscode.QuickPickItem);
		msgEmitter.fire({ type: 'commitAction', action: 'reset', hash: sha });

		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('v2.0.0')
			.mockResolvedValueOnce('Release 2.0.0');
		msgEmitter.fire({ type: 'commitAction', action: 'tag', hash: sha });

		msgEmitter.fire({ type: 'commitAction', action: 'pushUpToHere', hash: sha });
		msgEmitter.fire({ type: 'commitAction', action: 'showFullCommitDiff', hash: sha });
		msgEmitter.fire({ type: 'commitAction', action: 'createPatch', hash: sha });
		msgEmitter.fire({ type: 'commitAction', action: 'copyHash', hash: sha });
		msgEmitter.fire({ type: 'commitAction', action: 'copySubject', hash: sha, subject: 'feat: initial' });
		msgEmitter.fire({ type: 'commitAction', action: 'interactiveRebase', hash: sha });

		// Non-zero exit and alternate branches in handleCommitAction
		vi.spyOn(gitCli, 'cherryPick').mockResolvedValueOnce({ stdout: '', stderr: 'conflict', exitCode: 1 });
		msgEmitter.fire({ type: 'commitAction', action: 'cherryPick', hash: sha });

		vi.spyOn(gitCli, 'revertCommit').mockResolvedValueOnce({ stdout: '', stderr: 'conflict', exitCode: 1 });
		msgEmitter.fire({ type: 'commitAction', action: 'revert', hash: sha });

		vi.spyOn(gitCli, 'dropSingleCommit').mockResolvedValueOnce({ stdout: '', stderr: 'conflict', exitCode: 1 });
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Drop Commit' as unknown as vscode.MessageItem);
		msgEmitter.fire({ type: 'commitAction', action: 'dropCommit', hash: sha });

		// rewordCommit on non-HEAD commit opens interactive rebase
		vi.spyOn(gitCli, 'getHeadCommitHash').mockResolvedValueOnce('different-head-sha');
		vi.spyOn(rebasePanel, 'openInteractiveRebase').mockResolvedValueOnce(undefined);
		msgEmitter.fire({ type: 'commitAction', action: 'rewordCommit', hash: sha });

		// Hard reset blocked on protected branch
		vi.spyOn(protectedGuard, 'canRewriteHistory').mockReturnValueOnce(false);
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Hard',
			mode: 'hard'
		} as unknown as vscode.QuickPickItem);
		msgEmitter.fire({ type: 'commitAction', action: 'reset', hash: sha });

		await new Promise(r => setTimeout(r, 40));
		expect(postMessage).toHaveBeenCalled();
		logViewProvider.dispose();
	});

	it('activates extension and invokes registered commands across modules', async () => {
		const subscriptions: { dispose: () => unknown }[] = [];
		const mockContext = {
			subscriptions,
			workspaceState: {
				keys: () => [],
				get: <T>(_k: string, def?: T): T => def as T,
				update: vi.fn(async () => undefined)
			}
		} as unknown as vscode.ExtensionContext;

		vi.mocked(vscode.window.registerTreeDataProvider).mockClear();
		await activate(mockContext);
		expect(subscriptions.length).toBeGreaterThan(10);
		expect(vscode.window.registerTreeDataProvider).not.toHaveBeenCalled();

		// First invoke resource commands with no activeTextEditor and no args (tests empty uris branches)
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
		await registeredCommands.get('commitPro.stageResource')?.();
		await registeredCommands.get('commitPro.unstageResource')?.();
		await registeredCommands.get('commitPro.rollbackResource')?.();
		await registeredCommands.get('commitPro.deleteChangelist')?.();

		const allCmds = Array.from(registeredCommands.keys());
		for (const cmdId of allCmds) {
			const handler = registeredCommands.get(cmdId);
			if (handler) {
				try {
					await handler({ resourceUri: vscode.Uri.file('/workspace/repo/a.ts'), id: 'changelist:default-changes' });
				} catch {
					// Ignore mocked CLI errors during bulk command smoke run
				}
			}
		}

		deactivate();
	});
});
