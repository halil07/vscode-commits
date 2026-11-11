import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ChangelistStore } from '../modules/changelist/changelistStore';
import { CommitProScmProvider } from '../modules/changelist/scmProvider';
import { PartialChunkService } from '../modules/changelist/partialChunkService';
import { GitCliService } from '../core/gitCliService';
import { RepositoryManager } from '../modules/repository/repositoryManager';

describe('ChangelistStore, CommitProScmProvider & PartialChunkService', () => {
	let gitCli: GitCliService;
	let repoManager: RepositoryManager;
	let changelistStore: ChangelistStore;
	let scmProvider: CommitProScmProvider;
	let partialService: PartialChunkService;
	let mementoState: Record<string, unknown>;

	beforeEach(() => {
		mementoState = {
			'commitPro.changelistsByRepo': {
				'/saved-repo': [
					{
						id: 'default-changes',
						name: 'Changes',
						comment: '',
						isActive: true,
						isDefault: true,
						files: ['saved.ts']
					}
				]
			}
		};
		const mockMemento: vscode.Memento = {
			keys: () => Object.keys(mementoState),
			get: <T>(key: string, defaultValue?: T): T => (mementoState[key] as T) ?? (defaultValue as T),
			update: vi.fn(async (key: string, value: unknown) => {
				mementoState[key] = value;
			})
		};

		gitCli = new GitCliService();
		repoManager = new RepositoryManager(gitCli);
		changelistStore = new ChangelistStore(mockMemento);
		scmProvider = new CommitProScmProvider(gitCli, repoManager, changelistStore);
		partialService = new PartialChunkService(gitCli, repoManager, changelistStore, scmProvider);

		vi.spyOn(repoManager, 'getRepositories').mockReturnValue([
			{
				rootPath: '/repo',
				rootUri: vscode.Uri.file('/repo'),
				name: 'repo',
				isExplicitMapping: false,
				isSubmodule: false,
				currentBranch: 'main',
				ahead: 0,
				behind: 0,
				isDetachedHead: false
			}
		]);
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValue(repoManager.getRepositories()[0]);
		vi.spyOn(repoManager, 'getRepositoryForUri').mockReturnValue(repoManager.getRepositories()[0]);
	});

	it('manages Changelist lifecycle: default list, create, activate, move files, reconcile, delete active', async () => {
		expect(changelistStore.getChangelists('/saved-repo')[0].files).toContain('saved.ts');

		const initial = changelistStore.getChangelists('/repo');
		expect(initial.length).toBe(1);
		expect(initial[0].isDefault).toBe(true);

		const featList = await changelistStore.createChangelist('/repo', 'Feature-UI', 'UI work', true);
		expect(changelistStore.getActiveChangelist('/repo').id).toBe(featList.id);

		await changelistStore.reconcileChanges('/repo', [
			{
				repoRoot: '/repo',
				relativePath: 'src/a.ts',
				uri: vscode.Uri.file('/repo/src/a.ts'),
				indexStatus: 'M',
				workTreeStatus: '.',
				isConflicted: false,
				isUntracked: false,
				isStaged: true,
				isModifiedInWorkTree: false
			}
		]);

		await changelistStore.moveFilesToChangelist('/repo', ['src/a.ts'], 'non-existent-id');
		await changelistStore.moveFilesToChangelist('/repo', ['src/a.ts'], featList.id);

		// Delete active changelist restores active flag to default list
		await changelistStore.deleteChangelist('/repo', featList.id);
		expect(changelistStore.getActiveChangelist('/repo').id).toBe('default-changes');
		changelistStore.dispose();
	});

	it('syncs repositories, removes stale repos, toggles staging mode, and provides original content', async () => {
		vi.spyOn(gitCli, 'getRepositoryStatus').mockResolvedValue({
			branch: 'main',
			upstream: 'origin/main',
			ahead: 1,
			behind: 0,
			isDetached: false,
			changes: [
				{
					repoRoot: '/repo',
					relativePath: 'src/index.ts',
					uri: vscode.Uri.file('/repo/src/index.ts'),
					indexStatus: 'M',
					workTreeStatus: 'M',
					isConflicted: false,
					isUntracked: false,
					isStaged: true,
					isModifiedInWorkTree: true
				}
			]
		});

		await scmProvider.syncAllRepositories();
		expect(scmProvider.getLatestChanges('/repo').length).toBe(1);

		// Sync when repositories list is empty -> disposes removed repo context
		vi.spyOn(repoManager, 'getRepositories').mockReturnValueOnce([]);
		await scmProvider.syncAllRepositories();

		await scmProvider.toggleStagingModeInteractive();
		await scmProvider.toggleStagingModeInteractive();

		vi.spyOn(gitCli, 'showFileAtRevision').mockResolvedValue('original-head-content');
		const origUri = scmProvider.provideOriginalResource(vscode.Uri.file('/repo/src/index.ts'));
		expect(await scmProvider.provideTextDocumentContent(origUri)).toBe('original-head-content');

		const revUri = scmProvider.createRevisionUri('/repo', 'src/index.ts', 'abcdef1');
		expect(revUri.path.endsWith('src/index.ts')).toBe(true);
		expect(await scmProvider.provideTextDocumentContent(revUri)).toBe('original-head-content');

		vi.spyOn(gitCli, 'showFullCommit').mockResolvedValueOnce('diff --git full');
		const fullDiffUri = scmProvider.createPatchUri('/repo', 'commit-abcdef1.diff', 'abcdef1', false);
		expect(await scmProvider.provideTextDocumentContent(fullDiffUri)).toBe('diff --git full');

		vi.spyOn(gitCli, 'formatCommitPatch').mockResolvedValueOnce('From abcdef1');
		const formatPatchUri = scmProvider.createPatchUri('/repo', 'abcdef1.patch', 'abcdef1', true);
		expect(await scmProvider.provideTextDocumentContent(formatPatchUri)).toBe('From abcdef1');

		// Invalid query returns empty string
		expect(await scmProvider.provideTextDocumentContent(vscode.Uri.file('/invalid'))).toBe('');

		await scmProvider.openFileDiff(vscode.Uri.file('/repo/src/index.ts'));
		scmProvider.dispose();
	});

	it('executes PartialChunkService: editor missing warnings, rollback, stage, and moveResources', async () => {
		// When no active editor
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
		await partialService.rollbackSelectedLines();
		await partialService.stageSelectedLines();
		await partialService.moveResourcesToChangelistInteractive();

		const replaceMock = vi.fn();
		(vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
			document: {
				uri: vscode.Uri.file('/repo/src/index.ts'),
				getText: () => 'new-line-1\nnew-line-2\n',
				lineCount: 2,
				lineAt: () => ({ text: 'new-line-1' }),
				save: vi.fn(async () => true)
			},
			selection: new vscode.Selection(0, 0, 0, 10),
			edit: vi.fn(async (cb: (eb: { replace: typeof replaceMock }) => void) => {
				cb({ replace: replaceMock });
				return true;
			}),
			setDecorations: vi.fn()
		};

		// Empty headContent warns
		vi.spyOn(gitCli, 'showFileAtRevision').mockResolvedValueOnce('');
		await partialService.rollbackSelectedLines();

		vi.spyOn(gitCli, 'showFileAtRevision').mockResolvedValue('old-line-1\nold-line-2\n');
		vi.spyOn(gitCli, 'applyPatchToIndex').mockResolvedValueOnce(undefined);
		vi.spyOn(scmProvider, 'refreshRepository').mockResolvedValue(undefined);

		await partialService.rollbackSelectedLines();
		expect(replaceMock).toHaveBeenCalled();

		await partialService.stageSelectedLines();
		expect(gitCli.applyPatchToIndex).toHaveBeenCalled();

		// stageSelectedLines error path
		vi.spyOn(gitCli, 'applyPatchToIndex').mockRejectedValueOnce(new Error('patch error'));
		await partialService.stageSelectedLines();

		// Move to existing changelist using activeTextEditor fallback
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: 'Changes',
			id: 'default-changes'
		} as unknown as vscode.QuickPickItem);
		await partialService.moveResourcesToChangelistInteractive();

		// Move to newly created changelist
		vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
			label: '$(add) Create New Changelist...',
			id: '__new__'
		} as unknown as vscode.QuickPickItem);
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Hotfix-List');

		await partialService.moveResourcesToChangelistInteractive({
			resourceUri: vscode.Uri.file('/repo/src/index.ts')
		});
		expect(changelistStore.getActiveChangelist('/repo').name).toBe('Hotfix-List');
	});
});
