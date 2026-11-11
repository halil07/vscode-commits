import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from '../../core/gitCliService';
import { RepositoryManager } from '../repository/repositoryManager';
import { ChangelistStore } from './changelistStore';
import { CommitProScmProvider } from './scmProvider';

/**
 * Partial Commit (Chunks / Lines) & Line-Level Rollback Service.
 * Enables rolling back selected lines in the active editor or staging only selected lines
 * into the Git index via unified diff construction (`git apply --cached --unidiff-zero`).
 */
export class PartialChunkService {
	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly changelistStore: ChangelistStore,
		private readonly scmProvider: CommitProScmProvider
	) {}

	public async rollbackSelectedLines(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a modified file and select lines to rollback.');
			return;
		}

		const doc = editor.document;
		const repo = this.repoManager.getRepositoryForUri(doc.uri);
		if (!repo) {
			return;
		}

		const relPath = path.relative(repo.rootPath, doc.uri.fsPath).replace(/\\/g, '/');
		const headContent = await this.gitCli.showFileAtRevision(repo.rootPath, `HEAD:${relPath}`);
		if (!headContent) {
			vscode.window.showWarningMessage('File has no HEAD revision to rollback from.');
			return;
		}

		const headLines = headContent.split(/\r?\n/);
		const selection = editor.selection;
		const startLine = selection.start.line;
		const endLine = selection.end.line;

		const replacementSlice = headLines.slice(startLine, Math.min(endLine + 1, headLines.length));
		const rangeToReplace = new vscode.Range(
			new vscode.Position(startLine, 0),
			new vscode.Position(endLine, doc.lineAt(endLine).text.length)
		);

		await editor.edit(editBuilder => {
			editBuilder.replace(rangeToReplace, replacementSlice.join('\n'));
		});
		await doc.save();
		await this.scmProvider.refreshRepository(repo.rootPath);
		vscode.window.showInformationMessage(`Rolled back lines ${startLine + 1}–${endLine + 1} in ${path.basename(doc.uri.fsPath)}.`);
	}

	public async stageSelectedLines(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a modified file and select lines to stage.');
			return;
		}

		const doc = editor.document;
		const repo = this.repoManager.getRepositoryForUri(doc.uri);
		if (!repo) {
			return;
		}

		const relPath = path.relative(repo.rootPath, doc.uri.fsPath).replace(/\\/g, '/');
		const indexContent = await this.gitCli.showFileAtRevision(repo.rootPath, `:0:${relPath}`);
		const indexLines = indexContent.split(/\r?\n/);
		const workingLines = doc.getText().split(/\r?\n/);

		const startLine = editor.selection.start.line;
		const endLine = editor.selection.end.line;

		const oldSlice = indexLines.slice(startLine, Math.min(endLine + 1, indexLines.length));
		const newSlice = workingLines.slice(startLine, endLine + 1);

		const oldStart = startLine + 1;
		const oldCount = oldSlice.length;
		const newStart = startLine + 1;
		const newCount = newSlice.length;

		const patchLines: string[] = [
			`diff --git a/${relPath} b/${relPath}`,
			`--- a/${relPath}`,
			`+++ b/${relPath}`,
			`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
			...oldSlice.map(l => `-${l}`),
			...newSlice.map(l => `+${l}`),
			''
		];

		try {
			await this.gitCli.applyPatchToIndex(repo.rootPath, patchLines.join('\n'));
			await this.scmProvider.refreshRepository(repo.rootPath);
			vscode.window.showInformationMessage(`Staged lines ${startLine + 1}–${endLine + 1} of ${relPath}.`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Could not stage selected chunk: ${msg}`);
		}
	}

	public async moveResourcesToChangelistInteractive(
		...resourceStates: vscode.SourceControlResourceState[]
	): Promise<void> {
		const uris =
			resourceStates.length > 0
				? resourceStates.map(r => r.resourceUri)
				: vscode.window.activeTextEditor
					? [vscode.window.activeTextEditor.document.uri]
					: [];

		if (uris.length === 0) {
			vscode.window.showWarningMessage('Select one or more changed files to move to a Changelist.');
			return;
		}

		const repo = this.repoManager.getRepositoryForUri(uris[0]);
		if (!repo) {
			return;
		}

		const lists = this.changelistStore.getChangelists(repo.rootPath);
		const pick = await vscode.window.showQuickPick(
			[
				...lists.map(l => ({
					label: `${l.isActive ? '$(check) ' : ''}${l.name}`,
					description: l.isDefault ? 'Default Changelist' : l.comment,
					id: l.id
				})),
				{
					label: '$(add) Create New Changelist...',
					description: 'Create a new bucket and move selected files into it',
					id: '__new__'
				}
			],
			{ placeHolder: `Move ${uris.length} file(s) to Changelist` }
		);

		if (!pick) {
			return;
		}

		let targetListId = pick.id;
		if (targetListId === '__new__') {
			const newName = await vscode.window.showInputBox({
				prompt: 'New Changelist Name',
				placeHolder: 'e.g., Auth-Refactor, Hotfix-104'
			});
			if (!newName) {
				return;
			}
			const created = await this.changelistStore.createChangelist(repo.rootPath, newName, '', true);
			targetListId = created.id;
		}

		const relPaths = uris.map(u => path.relative(repo.rootPath, u.fsPath).replace(/\\/g, '/'));
		await this.changelistStore.moveFilesToChangelist(repo.rootPath, relPaths, targetListId);
	}
}
