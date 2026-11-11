import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { GitCliService } from '../../core/gitCliService';
import { InteractiveRebaseEntry, RebaseAction } from '../../core/types';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { ProtectedBranchGuard } from '../audit/protectedBranchGuard';

/**
 * Visual Interactive Rebase Console (`git rebase -i`).
 * Presents commits in a reorderable graphical table with color-coded action pills
 * (`pick`, `reword`, `edit`, `squash`, `fixup`, `drop`) and inline commit message rewording.
 */
export class InteractiveRebasePanel {
	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly scmProvider: CommitProScmProvider,
		private readonly protectedGuard: ProtectedBranchGuard
	) {}

	public async openInteractiveRebase(baseCommitSha?: string): Promise<void> {
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		if (!this.protectedGuard.canRewriteHistory(repo.currentBranch, 'Interactive Rebase')) {
			return;
		}

		const commits = await this.gitCli.getCommitLog(repo.rootPath, {
			branch: 'HEAD',
			maxCount: 30
		});

		if (commits.length < 2) {
			vscode.window.showWarningMessage('Need at least 2 commits in history to run Interactive Rebase.');
			return;
		}

		let selectedBase = baseCommitSha;
		if (!selectedBase) {
			const picked = await vscode.window.showQuickPick(
				commits.slice(0, -1).map(c => ({
					label: `${c.shortHash} — ${c.subject}`,
					description: c.authorName,
					hash: c.hash
				})),
				{ placeHolder: 'Interactively Rebase from Here (Select earliest commit to include)' }
			);
			if (!picked) {
				return;
			}
			selectedBase = picked.hash;
		}

		const targetIndex = commits.findIndex(c => c.hash === selectedBase || c.shortHash === selectedBase);
		const sliceCount = targetIndex >= 0 ? targetIndex + 1 : Math.min(commits.length - 1, 8);
		const rebaseCommits: InteractiveRebaseEntry[] = commits
			.slice(0, sliceCount)
			.reverse()
			.map(c => ({
				hash: c.hash,
				shortHash: c.shortHash,
				author: c.authorName,
				dateIso: c.authorDateIso.slice(0, 10),
				subject: c.subject,
				action: 'pick' as RebaseAction
			}));

		const parentRef = `${rebaseCommits[0].hash}~1`;

		const panel = vscode.window.createWebviewPanel(
			'commitProInteractiveRebase',
			`Interactive Rebase (${repo.currentBranch})`,
			vscode.ViewColumn.Active,
			{ enableScripts: true }
		);

		panel.webview.html = this.getHtml(panel.webview, repo.currentBranch, rebaseCommits);

		panel.webview.onDidReceiveMessage(async msg => {
			if (msg.type === 'startRebase') {
				const entries = msg.entries as InteractiveRebaseEntry[];
				await this.executeAutomatedInteractiveRebase(repo.rootPath, parentRef, entries);
				panel.dispose();
			} else if (msg.type === 'cancel') {
				panel.dispose();
			}
		});
	}

	private async executeAutomatedInteractiveRebase(
		repoRoot: string,
		parentRef: string,
		entries: InteractiveRebaseEntry[]
	): Promise<void> {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-pro-rebase-'));
		try {
			const todoLines = entries.map(e => `${e.action} ${e.shortHash} ${e.subject}`);
			const todoFilePath = path.join(tmpDir, 'rebase-todo.txt').replace(/\\/g, '/');
			await fs.writeFile(todoFilePath, todoLines.join('\n') + '\n', 'utf8');

			const seqEditorScriptPath = path.join(tmpDir, 'seq-editor.js').replace(/\\/g, '/');
			await fs.writeFile(
				seqEditorScriptPath,
				`const fs = require('fs');\nconst target = process.argv[2];\nconst content = fs.readFileSync('${todoFilePath}', 'utf8');\nfs.writeFileSync(target, content, 'utf8');\n`,
				'utf8'
			);

			const res = await this.gitCli.execGit(
				repoRoot,
				['rebase', '-i', parentRef],
				{
					env: {
						GIT_SEQUENCE_EDITOR: `node "${seqEditorScriptPath}"`
					},
					allowNonZeroExit: true
				}
			);

			await this.scmProvider.refreshRepository(repoRoot);
			if (res.exitCode === 0) {
				vscode.window.showInformationMessage('Interactive Rebase completed successfully.');
			} else {
				vscode.window.showWarningMessage(`Interactive Rebase paused (e.g. for edit/conflict): ${res.stderr.trim()}`);
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	private getHtml(
		webview: vscode.Webview,
		branchName: string,
		entries: InteractiveRebaseEntry[]
	): string {
		const nonce = String(Date.now());
		const initialJson = JSON.stringify(entries);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	* { box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 20px 24px;
		margin: 0;
	}
	.header-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
		margin-bottom: 16px;
	}
	.header-bar h2 {
		margin: 0;
		font-size: 16px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.branch-tag {
		font-size: 12px;
		padding: 2px 8px;
		border-radius: 4px;
		background: rgba(56, 139, 253, 0.2);
		color: #79c0ff;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-bottom: 18px;
		font-size: 12.5px;
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22));
		border-radius: 6px;
		overflow: hidden;
	}
	th, td {
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.16));
		padding: 8px 10px;
		text-align: left;
	}
	th {
		background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		opacity: 0.8;
	}
	tr:hover {
		background: var(--vscode-list-hoverBackground);
	}
	select, input[type="text"] {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 12px;
		outline: none;
	}
	select:focus, input[type="text"]:focus {
		border-color: var(--vscode-focusBorder, #388bfd);
	}
	input[type="text"] { width: 100%; }
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		border-radius: 5px;
		padding: 7px 14px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
	}
	button:hover {
		background: var(--vscode-button-hoverBackground);
	}
	button.secondary {
		background: rgba(128, 128, 128, 0.16);
		color: var(--vscode-foreground);
		padding: 4px 8px;
	}
	button.secondary:hover {
		background: rgba(128, 128, 128, 0.28);
	}
	.drop-row { opacity: 0.45; text-decoration: line-through; }
	.squash-row td:nth-child(4) { padding-left: 26px; }
	.footer-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
</style>
</head>
<body>
	<div class="header-bar">
		<h2>⇄ Interactively Rebase <span class="branch-tag">⎇ ${branchName}</span></h2>
		<span style="font-size:12px;opacity:0.7;">Oldest commit at top • Newest commit at bottom</span>
	</div>

	<table>
		<thead>
			<tr>
				<th style="width:85px;">Order</th>
				<th style="width:130px;">Action</th>
				<th style="width:90px;">SHA</th>
				<th>Commit Message</th>
				<th style="width:140px;">Author</th>
				<th style="width:105px;">Date</th>
			</tr>
		</thead>
		<tbody id="rebaseBody"></tbody>
	</table>

	<div class="footer-actions">
		<button class="secondary" id="cancelBtn">Cancel</button>
		<button id="startBtn">▶ Start Rebasing</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let entries = ${initialJson};
		const tbody = document.getElementById('rebaseBody');

		function render() {
			tbody.innerHTML = '';
			entries.forEach((e, idx) => {
				const tr = document.createElement('tr');
				if (e.action === 'drop') tr.className = 'drop-row';
				else if (e.action === 'squash' || e.action === 'fixup') tr.className = 'squash-row';

				tr.innerHTML =
					'<td><button class="secondary" data-up="' + idx + '" title="Move Up">↑</button> <button class="secondary" data-down="' + idx + '" title="Move Down">↓</button></td>' +
					'<td><select data-action="' + idx + '">' +
						['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'].map(a =>
							'<option value="' + a + '"' + (e.action === a ? ' selected' : '') + '>' + a.toUpperCase() + '</option>'
						).join('') +
					'</select></td>' +
					'<td><code>' + e.shortHash + '</code></td>' +
					'<td><input type="text" data-subject="' + idx + '" value="' + e.subject.replace(/"/g, '&quot;') + '"></td>' +
					'<td>' + e.author + '</td>' +
					'<td style="opacity:0.75;">' + e.dateIso + '</td>';

				tbody.appendChild(tr);
			});

			tbody.querySelectorAll('button[data-up]').forEach(btn => {
				btn.addEventListener('click', () => {
					const i = Number(btn.getAttribute('data-up'));
					if (i > 0) {
						const tmp = entries[i - 1];
						entries[i - 1] = entries[i];
						entries[i] = tmp;
						render();
					}
				});
			});

			tbody.querySelectorAll('button[data-down]').forEach(btn => {
				btn.addEventListener('click', () => {
					const i = Number(btn.getAttribute('data-down'));
					if (i < entries.length - 1) {
						const tmp = entries[i + 1];
						entries[i + 1] = entries[i];
						entries[i] = tmp;
						render();
					}
				});
			});

			tbody.querySelectorAll('select[data-action]').forEach(sel => {
				sel.addEventListener('change', () => {
					const i = Number(sel.getAttribute('data-action'));
					entries[i].action = sel.value;
					render();
				});
			});

			tbody.querySelectorAll('input[data-subject]').forEach(inp => {
				inp.addEventListener('input', () => {
					const i = Number(inp.getAttribute('data-subject'));
					entries[i].subject = inp.value;
				});
			});
		}

		document.getElementById('cancelBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'cancel' });
		});
		document.getElementById('startBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'startRebase', entries });
		});

		render();
	</script>
</body>
</html>`;
	}
}
