import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from '../../core/gitCliService';
import { RepositoryManager } from '../repository/repositoryManager';

/**
 * Annotate with Git Blame & Code Block History (`git log -L`).
 * Renders age-ordered (recent = warm/bright, older = cool/muted) blame annotations
 * with rich commit hover details, plus file and selection history views.
 */
export class BlameAnnotationController implements vscode.Disposable {
	private readonly annotatedDocuments = new Set<string>();
	private readonly decorationTypes: vscode.TextEditorDecorationType[];
	private readonly disposables: vscode.Disposable[] = [];

	private static readonly AGE_COLORS = [
		{ bg: 'rgba(46, 160, 67, 0.20)', fg: '#7ee787' },
		{ bg: 'rgba(56, 139, 253, 0.18)', fg: '#79c0ff' },
		{ bg: 'rgba(139, 148, 158, 0.15)', fg: '#a5d6ff' },
		{ bg: 'rgba(110, 118, 129, 0.12)', fg: '#8b949e' },
		{ bg: 'rgba(110, 118, 129, 0.06)', fg: '#6e7681' }
	];

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager
	) {
		this.decorationTypes = BlameAnnotationController.AGE_COLORS.map(tier =>
			vscode.window.createTextEditorDecorationType({
				isWholeLine: false,
				before: {
					margin: '0 14px 0 0',
					backgroundColor: tier.bg,
					color: tier.fg,
					fontStyle: 'normal'
				}
			})
		);

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor && this.annotatedDocuments.has(editor.document.uri.toString())) {
					void this.applyAnnotations(editor);
				}
			})
		);
	}

	public async toggleAnnotateBlame(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a file in the editor to Annotate with Git Blame.');
			return;
		}

		const key = editor.document.uri.toString();
		if (this.annotatedDocuments.has(key)) {
			this.annotatedDocuments.delete(key);
			this.clearDecorations(editor);
			return;
		}

		this.annotatedDocuments.add(key);
		await this.applyAnnotations(editor);
	}

	private clearDecorations(editor: vscode.TextEditor): void {
		for (const dt of this.decorationTypes) {
			editor.setDecorations(dt, []);
		}
	}

	private async applyAnnotations(editor: vscode.TextEditor): Promise<void> {
		const uri = editor.document.uri;
		const repo = this.repoManager.getRepositoryForUri(uri);
		if (!repo) {
			return;
		}

		const relPath = path.relative(repo.rootPath, uri.fsPath).replace(/\\/g, '/');
		const blameLines = await this.gitCli.getFileBlame(repo.rootPath, relPath);
		if (blameLines.length === 0) {
			vscode.window.showInformationMessage('No committed Git Blame history available for this file.');
			return;
		}

		const timestamps = blameLines.map(b => b.authorTimestampSec).filter(t => t > 0);
		const minTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
		const maxTime = timestamps.length > 0 ? Math.max(...timestamps) : 1;
		const span = Math.max(1, maxTime - minTime);

		const buckets: vscode.DecorationOptions[][] = [[], [], [], [], []];

		for (const item of blameLines) {
			const zeroBasedLine = item.lineNumber - 1;
			if (zeroBasedLine < 0 || zeroBasedLine >= editor.document.lineCount) {
				continue;
			}

			const ageRatio = 1 - (item.authorTimestampSec - minTime) / span;
			const tierIndex = Math.min(4, Math.max(0, Math.floor(ageRatio * 5)));

			const dateStr = item.authorTimestampSec
				? new Date(item.authorTimestampSec * 1000).toISOString().slice(0, 10)
				: 'Uncommitted';
			const authorShort = item.author.slice(0, 14).padEnd(14, ' ');
			const label = ` ${dateStr} ${authorShort} ${item.shortHash} `;

			const hover = new vscode.MarkdownString(
				`### Commit \`${item.hash.slice(0, 10)}\`\n\n` +
				`- **Author:** ${item.author} ${item.authorEmail}\n` +
				`- **Date:** ${dateStr}\n` +
				`- **Summary:** ${item.summary}\n`
			);
			hover.isTrusted = true;

			buckets[tierIndex].push({
				range: new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0),
				hoverMessage: hover,
				renderOptions: {
					before: {
						contentText: label
					}
				}
			});
		}

		buckets.forEach((options, idx) => {
			editor.setDecorations(this.decorationTypes[idx], options);
		});
	}

	public async showFileHistory(resourceUri?: vscode.Uri): Promise<void> {
		const targetUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!targetUri) {
			vscode.window.showWarningMessage('Select or open a file to view its Git History.');
			return;
		}
		const repo = this.repoManager.getRepositoryForUri(targetUri);
		if (!repo) {
			return;
		}
		const relPath = path.relative(repo.rootPath, targetUri.fsPath).replace(/\\/g, '/');
		await vscode.commands.executeCommand('commitPro.focusLogWindow', undefined, relPath);
	}

	public async showSelectionHistory(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Select a block of code in the editor first.');
			return;
		}
		const repo = this.repoManager.getRepositoryForUri(editor.document.uri);
		if (!repo) {
			return;
		}

		const relPath = path.relative(repo.rootPath, editor.document.uri.fsPath).replace(/\\/g, '/');
		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;

		const logOutput = await this.gitCli.getSelectionHistory(repo.rootPath, relPath, startLine, endLine);
		if (!logOutput.trim()) {
			vscode.window.showInformationMessage(`No history found for lines ${startLine}–${endLine} of ${relPath}.`);
			return;
		}

		const doc = await vscode.workspace.openTextDocument({
			content: `# Git History for Selection: ${relPath} (Lines ${startLine}..${endLine})\n\n${logOutput}`,
			language: 'diff'
		});
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
	}

	public dispose(): void {
		for (const dt of this.decorationTypes) {
			dt.dispose();
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
