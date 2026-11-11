import * as vscode from 'vscode';
import * as path from 'path';
import { GitCliService } from '../../core/gitCliService';
import { CommitOptions } from '../../core/types';
import { ChangelistStore } from '../changelist/changelistStore';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { CommitWorkflowService } from './commitWorkflowService';

/**
 * Non-Modal Commit Tool Window (Alt+0) (`commitPro.commitToolView`).
 * Provides Changelist selector, per-file checkboxes, diff preview trigger,
 * 72-char commit message box, Amend / Sign-off / GPG / Author options,
 * Pre-Commit Quality Gate toggles, and split Commit / Commit & Push buttons.
 */
export class CommitToolViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'commitPro.commitToolView';
	private view?: vscode.WebviewView;

	constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly changelistStore: ChangelistStore,
		private readonly scmProvider: CommitProScmProvider,
		private readonly commitService: CommitWorkflowService
	) {
		this.scmProvider.onDidUpdateStatus(() => this.postStateToWebview());
		this.changelistStore.onDidChangeChangelists(() => this.postStateToWebview());
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async msg => {
			const repo = this.repoManager.getActiveRepository();
			if (!repo) {
				return;
			}

			switch (msg.type) {
				case 'ready':
				case 'refresh':
					await this.scmProvider.refreshRepository(repo.rootPath);
					this.postStateToWebview();
					break;

				case 'setActiveChangelist':
					await this.changelistStore.setActiveChangelist(repo.rootPath, msg.changelistId);
					break;

				case 'newChangelist':
					await vscode.commands.executeCommand('commitPro.newChangelist');
					break;

				case 'openDiff': {
					const uri = vscode.Uri.file(path.join(repo.rootPath, msg.relativePath));
					await this.scmProvider.openFileDiff(uri);
					break;
				}

				case 'loadLastMessage': {
					const lastMsg = await this.gitCli.getLastCommitMessage(repo.rootPath);
					this.view?.webview.postMessage({ type: 'setCommitMessage', message: lastMsg });
					break;
				}

				case 'commit': {
					const options: CommitOptions = {
						message: msg.message || '',
						amend: Boolean(msg.amend),
						signOff: Boolean(msg.signOff),
						gpgSign: Boolean(msg.gpgSign),
						author: msg.author || undefined,
						runGitHooks: msg.runGitHooks !== false,
						reformatCode: Boolean(msg.reformatCode),
						optimizeImports: Boolean(msg.optimizeImports),
						analyzeCode: Boolean(msg.analyzeCode),
						checkTodo: Boolean(msg.checkTodo),
						pushAfterCommit: Boolean(msg.pushAfterCommit)
					};
					const ok = await this.commitService.executeCommit(repo.rootPath, options, msg.selectedFiles);
					if (ok) {
						this.view?.webview.postMessage({ type: 'commitSucceeded' });
					}
					break;
				}
			}
		});

		this.postStateToWebview();
	}

	public focus(): void {
		this.view?.show?.(true);
		this.postStateToWebview();
	}

	private postStateToWebview(): void {
		if (!this.view) {
			return;
		}
		const repo = this.repoManager.getActiveRepository();
		if (!repo) {
			return;
		}

		const changelists = this.changelistStore.getChangelists(repo.rootPath);
		const allChanges = this.scmProvider.getLatestChanges(repo.rootPath);
		const untracked = allChanges.filter(c => c.isUntracked).map(c => c.relativePath);
		const config = vscode.workspace.getConfiguration('commitPro.qualityGates');

		this.view.webview.postMessage({
			type: 'state',
			repoName: repo.name,
			branch: repo.currentBranch,
			stagingMode: this.scmProvider.getStagingMode(),
			changelists,
			untracked,
			qualityGates: {
				reformatCode: config.get<boolean>('reformatCode', false),
				optimizeImports: config.get<boolean>('optimizeImports', false),
				analyzeCode: config.get<boolean>('analyzeCode', true),
				checkTodo: config.get<boolean>('checkTodo', true)
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		padding: 8px;
		margin: 0;
	}
	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
		font-weight: 600;
	}
	.changelist-bar {
		display: flex;
		gap: 4px;
		margin-bottom: 8px;
	}
	select, input[type="text"], textarea {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, #444);
		border-radius: 3px;
		padding: 4px 6px;
		font-family: inherit;
		font-size: 12px;
	}
	select { flex: 1; }
	.files-box {
		border: 1px solid var(--vscode-panel-border, #333);
		border-radius: 4px;
		max-height: 210px;
		overflow-y: auto;
		padding: 4px;
		margin-bottom: 8px;
	}
	.file-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		border-radius: 3px;
		cursor: pointer;
	}
	.file-row:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.file-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}
	.msg-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 4px;
		font-size: 11px;
		opacity: 0.85;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		min-height: 76px;
		resize: vertical;
		font-family: var(--vscode-editor-font-family, monospace);
		margin-bottom: 6px;
	}
	.section-title {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		opacity: 0.75;
		margin: 6px 0 4px;
	}
	.options-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px;
		font-size: 11.5px;
		margin-bottom: 8px;
	}
	.options-grid label {
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	.author-row {
		margin-bottom: 8px;
	}
	.author-row input {
		width: 100%;
		box-sizing: border-box;
	}
	.btn-row {
		display: flex;
		gap: 6px;
	}
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		border-radius: 3px;
		padding: 6px 10px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 500;
	}
	button:hover {
		background: var(--vscode-button-hoverBackground);
	}
	button.secondary {
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}
	.flex-1 { flex: 1; }
</style>
</head>
<body>
	<div class="header">
		<span id="repoLabel">Commit Tool Window</span>
		<button class="secondary" id="refreshBtn" title="Refresh Status">↻</button>
	</div>

	<div class="changelist-bar">
		<select id="changelistSelect" title="Active Changelist"></select>
		<button class="secondary" id="newListBtn" title="New Changelist">+ List</button>
	</div>

	<div class="files-box" id="filesContainer"></div>

	<div class="msg-header">
		<span id="charCount">0 chars (72 limit recommended)</span>
		<button class="secondary" id="lastMsgBtn" style="padding:2px 6px;font-size:11px;">History / Amend Msg</button>
	</div>
	<textarea id="commitMsg" placeholder="Commit message..."></textarea>

	<div class="section-title">Commit Options</div>
	<div class="options-grid">
		<label><input type="checkbox" id="optAmend"> Amend commit</label>
		<label><input type="checkbox" id="optSignOff"> Sign-off (--signoff)</label>
		<label><input type="checkbox" id="optGpg"> GPG Sign (-S)</label>
		<label><input type="checkbox" id="optHooks" checked> Run Git Hooks</label>
	</div>
	<div class="author-row">
		<input type="text" id="optAuthor" placeholder="Author override: Name <email@domain.com> (optional)">
	</div>

	<div class="section-title">Pre-Commit Quality Gates</div>
	<div class="options-grid">
		<label><input type="checkbox" id="gateFormat"> Reformat code</label>
		<label><input type="checkbox" id="gateImports"> Optimize imports</label>
		<label><input type="checkbox" id="gateAnalyze" checked> Analyze code (LSP)</label>
		<label><input type="checkbox" id="gateTodo" checked> Check TODO/FIXME</label>
	</div>

	<div class="btn-row">
		<button class="flex-1" id="commitBtn">Commit</button>
		<button class="flex-1 secondary" id="commitPushBtn">Commit and Push…</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let currentState = null;

		const changelistSelect = document.getElementById('changelistSelect');
		const filesContainer = document.getElementById('filesContainer');
		const commitMsg = document.getElementById('commitMsg');
		const charCount = document.getElementById('charCount');

		commitMsg.addEventListener('input', () => {
			const firstLine = (commitMsg.value.split('\\n')[0] || '').length;
			charCount.textContent = firstLine + ' chars on line 1' + (firstLine > 72 ? ' ⚠️ (>72)' : '');
		});

		document.getElementById('refreshBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
		});

		document.getElementById('newListBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'newChangelist' });
		});

		document.getElementById('lastMsgBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'loadLastMessage' });
		});

		changelistSelect.addEventListener('change', () => {
			vscode.postMessage({ type: 'setActiveChangelist', changelistId: changelistSelect.value });
		});

		function getSelectedFiles() {
			const boxes = filesContainer.querySelectorAll('input[type="checkbox"][data-file]');
			const selected = [];
			boxes.forEach(b => {
				if (b.checked) {
					selected.push(b.getAttribute('data-file'));
				}
			});
			return selected;
		}

		function triggerCommit(pushAfterCommit) {
			vscode.postMessage({
				type: 'commit',
				message: commitMsg.value,
				selectedFiles: getSelectedFiles(),
				amend: document.getElementById('optAmend').checked,
				signOff: document.getElementById('optSignOff').checked,
				gpgSign: document.getElementById('optGpg').checked,
				author: document.getElementById('optAuthor').value,
				runGitHooks: document.getElementById('optHooks').checked,
				reformatCode: document.getElementById('gateFormat').checked,
				optimizeImports: document.getElementById('gateImports').checked,
				analyzeCode: document.getElementById('gateAnalyze').checked,
				checkTodo: document.getElementById('gateTodo').checked,
				pushAfterCommit
			});
		}

		document.getElementById('commitBtn').addEventListener('click', () => triggerCommit(false));
		document.getElementById('commitPushBtn').addEventListener('click', () => triggerCommit(true));

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'state') {
				currentState = msg;
				document.getElementById('repoLabel').textContent = msg.repoName + ' (' + msg.branch + ')';
				document.getElementById('gateFormat').checked = msg.qualityGates.reformatCode;
				document.getElementById('gateImports').checked = msg.qualityGates.optimizeImports;
				document.getElementById('gateAnalyze').checked = msg.qualityGates.analyzeCode;
				document.getElementById('gateTodo').checked = msg.qualityGates.checkTodo;

				changelistSelect.innerHTML = '';
				let activeList = msg.changelists[0];
				for (const list of msg.changelists) {
					const opt = document.createElement('option');
					opt.value = list.id;
					opt.textContent = (list.isActive ? '● ' : '○ ') + list.name + ' (' + list.files.length + ')';
					if (list.isActive) {
						opt.selected = true;
						activeList = list;
					}
					changelistSelect.appendChild(opt);
				}

				filesContainer.innerHTML = '';
				const files = activeList ? activeList.files : [];
				if (files.length === 0 && (!msg.untracked || msg.untracked.length === 0)) {
					filesContainer.innerHTML = '<div style="opacity:0.6;padding:6px;font-size:12px;">No modified files in active changelist</div>';
				} else {
					for (const f of files) {
						const row = document.createElement('div');
						row.className = 'file-row';
						row.innerHTML = '<input type="checkbox" checked data-file="' + f + '"><span class="file-name" title="' + f + '">' + f + '</span>';
						row.querySelector('.file-name').addEventListener('click', () => {
							vscode.postMessage({ type: 'openDiff', relativePath: f });
						});
						filesContainer.appendChild(row);
					}
					if (msg.untracked && msg.untracked.length > 0) {
						const header = document.createElement('div');
						header.style.cssText = 'font-size:11px;opacity:0.7;margin-top:6px;padding:2px 4px;';
						header.textContent = 'Unversioned Files (' + msg.untracked.length + ')';
						filesContainer.appendChild(header);
						for (const u of msg.untracked) {
							const row = document.createElement('div');
							row.className = 'file-row';
							row.innerHTML = '<input type="checkbox" data-file="' + u + '"><span class="file-name" style="opacity:0.8;" title="' + u + '">' + u + '</span>';
							filesContainer.appendChild(row);
						}
					}
				}
			} else if (msg.type === 'setCommitMessage') {
				commitMsg.value = msg.message || '';
				commitMsg.dispatchEvent(new Event('input'));
			} else if (msg.type === 'commitSucceeded') {
				commitMsg.value = '';
				commitMsg.dispatchEvent(new Event('input'));
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}

	public dispose(): void {}
}
