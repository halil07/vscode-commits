import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { CommitOptions, QualityGateResult } from '../../core/types';

/**
 * FR-3.3: Pre-Commit AST & LSP Quality Gates Engine.
 * Executes Reformat Code, Optimize Imports, Static Code Analysis (Diagnostics),
 * and TODO/FIXME verification on files targeted for commit.
 */
export class QualityGatesService {
	public async runPreCommitQualityGates(
		repoRoot: string,
		relativeFilePaths: string[],
		options: CommitOptions
	): Promise<{ proceed: boolean; summary: QualityGateResult }> {
		const errors: string[] = [];
		const warnings: string[] = [];
		const todoItems: { file: string; line: number; text: string }[] = [];

		for (const relPath of relativeFilePaths) {
			const fullPath = path.join(repoRoot, relPath);
			const fileUri = vscode.Uri.file(fullPath);

			try {
				await fs.access(fullPath);
			} catch {
				// Deleted file; skip AST/LSP checks
				continue;
			}

			if (options.reformatCode) {
				await this.formatDocumentIfSupported(fileUri);
			}

			if (options.optimizeImports) {
				await this.optimizeImportsIfSupported(fileUri);
			}

			if (options.analyzeCode) {
				const diagnostics = vscode.languages.getDiagnostics(fileUri);
				for (const diag of diagnostics) {
					if (diag.severity === vscode.DiagnosticSeverity.Error) {
						errors.push(`${relPath}:${diag.range.start.line + 1} — ${diag.message}`);
					} else if (diag.severity === vscode.DiagnosticSeverity.Warning) {
						warnings.push(`${relPath}:${diag.range.start.line + 1} — ${diag.message}`);
					}
				}
			}

			if (options.checkTodo) {
				try {
					const content = await fs.readFile(fullPath, 'utf8');
					const lines = content.split(/\r?\n/);
					lines.forEach((lineText, idx) => {
						if (/\b(TODO|FIXME)\b/i.test(lineText)) {
							todoItems.push({
								file: relPath,
								line: idx + 1,
								text: lineText.trim()
							});
						}
					});
				} catch {
					// Ignore binary or unreadable files
				}
			}
		}

		if (errors.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`Code Analysis found ${errors.length} error(s) in files being committed (e.g. ${errors[0]}). Commit anyway?`,
				{ modal: true },
				'Commit Anyway',
				'Cancel'
			);
			if (choice !== 'Commit Anyway') {
				return {
					proceed: false,
					summary: { passed: false, errors, warnings, todoItems }
				};
			}
		}

		if (todoItems.length > 0) {
			const firstTodo = `${todoItems[0].file}:${todoItems[0].line} (${todoItems[0].text.slice(0, 60)})`;
			const choice = await vscode.window.showWarningMessage(
				`Check TODO found ${todoItems.length} TODO/FIXME item(s) (e.g. ${firstTodo}). Proceed with commit?`,
				{ modal: true },
				'Commit Anyway',
				'Cancel'
			);
			if (choice !== 'Commit Anyway') {
				return {
					proceed: false,
					summary: { passed: false, errors, warnings, todoItems }
				};
			}
		}

		return {
			proceed: true,
			summary: { passed: true, errors, warnings, todoItems }
		};
	}

	private async formatDocumentIfSupported(fileUri: vscode.Uri): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
				'vscode.executeFormatDocumentProvider',
				fileUri,
				{ tabSize: 4, insertSpaces: true }
			);
			if (edits && edits.length > 0) {
				const workspaceEdit = new vscode.WorkspaceEdit();
				workspaceEdit.set(fileUri, edits);
				await vscode.workspace.applyEdit(workspaceEdit);
				await doc.save();
			}
		} catch {
			// Formatter not available for this file type
		}
	}

	private async optimizeImportsIfSupported(fileUri: vscode.Uri): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const actions = await vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>(
				'vscode.executeCodeActionProvider',
				fileUri,
				new vscode.Range(0, 0, doc.lineCount, 0),
				vscode.CodeActionKind.SourceOrganizeImports.value
			);
			if (actions && actions.length > 0) {
				const first = actions[0] as vscode.CodeAction;
				if (first.edit) {
					await vscode.workspace.applyEdit(first.edit);
					await doc.save();
				}
			}
		} catch {
			// Organize imports not supported for this language
		}
	}
}
