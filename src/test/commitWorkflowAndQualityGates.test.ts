import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { GitCliService } from '../core/gitCliService';
import { RepositoryManager } from '../modules/repository/repositoryManager';
import { ChangelistStore } from '../modules/changelist/changelistStore';
import { CommitProScmProvider } from '../modules/changelist/scmProvider';
import { ProtectedBranchGuard } from '../modules/audit/protectedBranchGuard';
import { QualityGatesService } from '../modules/commit/qualityGatesService';
import { CommitWorkflowService } from '../modules/commit/commitWorkflowService';
import { CommitToolViewProvider } from '../modules/commit/commitToolViewProvider';

vi.mock('fs/promises', () => ({
	access: vi.fn(async () => undefined),
	readFile: vi.fn(async () => 'const x = 1;\n// TODO: refactor this\n'),
	writeFile: vi.fn(async () => undefined)
}));

describe('QualityGatesService, CommitWorkflowService & CommitToolViewProvider', () => {
	let gitCli: GitCliService;
	let repoManager: RepositoryManager;
	let changelistStore: ChangelistStore;
	let scmProvider: CommitProScmProvider;
	let protectedGuard: ProtectedBranchGuard;
	let qualityGates: QualityGatesService;
	let commitWorkflow: CommitWorkflowService;
	let commitToolView: CommitToolViewProvider;

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
		qualityGates = new QualityGatesService();
		commitWorkflow = new CommitWorkflowService(
			gitCli,
			repoManager,
			changelistStore,
			scmProvider,
			qualityGates,
			protectedGuard
		);
		commitToolView = new CommitToolViewProvider(
			gitCli,
			repoManager,
			changelistStore,
			scmProvider,
			commitWorkflow
		);

		vi.spyOn(repoManager, 'getRepositories').mockReturnValue([
			{
				rootPath: '/repo',
				rootUri: vscode.Uri.file('/repo'),
				name: 'repo',
				isExplicitMapping: false,
				isSubmodule: false,
				currentBranch: 'feature/test',
				ahead: 0,
				behind: 0,
				isDetachedHead: false
			}
		]);
		vi.spyOn(repoManager, 'getActiveRepository').mockReturnValue(repoManager.getRepositories()[0]);
	});

	it('runs Pre-Commit Quality Gates: proceed & cancel paths for diagnostics and TODOs', async () => {
		const getDiagnosticsMock = vi.mocked(
			vscode.languages.getDiagnostics as unknown as (uri: vscode.Uri) => vscode.Diagnostic[]
		);
		getDiagnosticsMock.mockReturnValueOnce([
			{
				severity: vscode.DiagnosticSeverity.Error,
				message: 'Type error on line 2',
				range: new vscode.Range(1, 0, 1, 10)
			} as unknown as vscode.Diagnostic,
			{
				severity: vscode.DiagnosticSeverity.Warning,
				message: 'Unused var',
				range: new vscode.Range(0, 0, 0, 5)
			} as unknown as vscode.Diagnostic
		]);

		vi.mocked(vscode.window.showWarningMessage)
			.mockResolvedValueOnce('Commit Anyway' as unknown as vscode.MessageItem)
			.mockResolvedValueOnce('Commit Anyway' as unknown as vscode.MessageItem);

		const res = await qualityGates.runPreCommitQualityGates('/repo', ['src/a.ts'], {
			message: 'feat: gate test',
			amend: false,
			signOff: false,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: true,
			optimizeImports: true,
			analyzeCode: true,
			checkTodo: true
		});

		expect(res.proceed).toBe(true);
		expect(res.summary.errors.length).toBe(1);
		expect(res.summary.warnings.length).toBe(1);
		expect(res.summary.todoItems.length).toBe(1);
		expect(fs.readFile).toHaveBeenCalled();

		// Cancel on diagnostic error
		getDiagnosticsMock.mockReturnValueOnce([
			{
				severity: vscode.DiagnosticSeverity.Error,
				message: 'Fatal error',
				range: new vscode.Range(0, 0, 0, 5)
			} as unknown as vscode.Diagnostic
		]);
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Cancel' as unknown as vscode.MessageItem);
		const cancelledDiag = await qualityGates.runPreCommitQualityGates('/repo', ['src/a.ts'], {
			message: 'feat: cancel diag',
			amend: false,
			signOff: false,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: false,
			optimizeImports: false,
			analyzeCode: true,
			checkTodo: false
		});
		expect(cancelledDiag.proceed).toBe(false);

		// Cancel on TODO item
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Cancel' as unknown as vscode.MessageItem);
		const cancelledTodo = await qualityGates.runPreCommitQualityGates('/repo', ['src/a.ts'], {
			message: 'feat: cancel todo',
			amend: false,
			signOff: false,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: false,
			optimizeImports: false,
			analyzeCode: false,
			checkTodo: true
		});
		expect(cancelledTodo.proceed).toBe(false);

		// Missing file skips gracefully
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('deleted'));
		const deletedRes = await qualityGates.runPreCommitQualityGates('/repo', ['src/deleted.ts'], {
			message: 'feat: deleted',
			amend: false,
			signOff: false,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: true,
			optimizeImports: true,
			analyzeCode: true,
			checkTodo: true
		});
		expect(deletedRes.proceed).toBe(true);
	});

	it('executes commit workflow across changelist/index modes, error paths, and undoLastCommitInteractive', async () => {
		vi.spyOn(gitCli, 'commit').mockResolvedValue('committed');
		vi.spyOn(gitCli, 'undoLastCommit').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'getLastCommitMessage').mockResolvedValue('feat: previous commit');
		vi.spyOn(scmProvider, 'refreshRepository').mockResolvedValue(undefined);
		vi.spyOn(protectedGuard, 'pushInteractive').mockResolvedValue(undefined);

		const baseOpts = {
			message: 'feat: new module',
			amend: false,
			signOff: true,
			gpgSign: false,
			runGitHooks: true,
			reformatCode: false,
			optimizeImports: false,
			analyzeCode: false,
			checkTodo: false
		};

		// Empty message should warn and return false
		expect(await commitWorkflow.executeCommit('/repo', { ...baseOpts, message: '   ' })).toBe(false);

		// No files in active changelist and not amend -> returns false
		expect(await commitWorkflow.executeCommit('/repo', baseOpts)).toBe(false);

		// Amend blocked on protected branch
		vi.spyOn(protectedGuard, 'canRewriteHistory').mockReturnValueOnce(false);
		expect(await commitWorkflow.executeCommit('/repo', { ...baseOpts, amend: true }, ['src/a.ts'])).toBe(false);

		// Index staging mode fallback
		vi.spyOn(scmProvider, 'getStagingMode').mockReturnValueOnce('index');
		vi.spyOn(scmProvider, 'getLatestChanges').mockReturnValueOnce([
			{
				repoRoot: '/repo',
				relativePath: 'src/staged.ts',
				uri: vscode.Uri.file('/repo/src/staged.ts'),
				indexStatus: 'M',
				workTreeStatus: '.',
				isConflicted: false,
				isUntracked: false,
				isStaged: true,
				isModifiedInWorkTree: false
			}
		]);
		expect(await commitWorkflow.executeCommit('/repo', baseOpts)).toBe(true);

		// Commit with pushAfterCommit
		const ok = await commitWorkflow.executeCommit('/repo', { ...baseOpts, pushAfterCommit: true }, ['src/a.ts']);
		expect(ok).toBe(true);
		expect(commitWorkflow.getRecentCommitMessages()).toContain('feat: new module');

		// CLI failure handled gracefully
		vi.spyOn(gitCli, 'commit').mockRejectedValueOnce(new Error('hook failed'));
		expect(await commitWorkflow.executeCommit('/repo', baseOpts, ['src/a.ts'])).toBe(false);

		// commitInteractive when inputBox is empty (prompts showInputBox)
		scmProvider.setInputBoxValue('/repo', '');
		changelistStore.getActiveChangelist('/repo').files.push('src/a.ts');
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('feat: prompted commit');
		await commitWorkflow.commitInteractive(false);

		// undoLastCommitInteractive
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Undo Commit' as unknown as vscode.MessageItem);
		await commitWorkflow.undoLastCommitInteractive();
		expect(gitCli.undoLastCommit).toHaveBeenCalledWith('/repo');
	});

	it('resolves CommitToolViewProvider webview and handles messages', async () => {
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

		vi.spyOn(scmProvider, 'refreshRepository').mockResolvedValue(undefined);
		vi.spyOn(gitCli, 'getLastCommitMessage').mockResolvedValue('feat: last msg');
		vi.spyOn(commitWorkflow, 'executeCommit').mockResolvedValue(true);

		commitToolView.resolveWebviewView(mockWebviewView);
		commitToolView.focus();
		msgEmitter.fire({ type: 'ready' });
		msgEmitter.fire({ type: 'setActiveChangelist', changelistId: 'default-changes' });
		msgEmitter.fire({ type: 'newChangelist' });
		msgEmitter.fire({ type: 'openDiff', relativePath: 'src/a.ts' });
		msgEmitter.fire({ type: 'loadLastMessage' });
		msgEmitter.fire({
			type: 'commit',
			message: 'feat: from webview',
			selectedFiles: ['src/a.ts'],
			amend: false
		});

		await new Promise(r => setTimeout(r, 20));
		expect(postMessage).toHaveBeenCalled();
		commitToolView.dispose();
	});
});
