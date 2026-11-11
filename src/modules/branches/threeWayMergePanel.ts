import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GitCliService } from '../../core/gitCliService';
import { CommitProScmProvider } from '../changelist/scmProvider';
import { RepositoryManager } from '../repository/repositoryManager';
import { Diff3Engine } from './diff3Engine';

/**
 * 3-Pane Visual Conflict Resolution Engine.
 * Displays Left (Yours / Local), Center (Editable Result initialized from Base revision),
 * and Right (Theirs / Incoming) with synchronized scrolling, "Magic Wand"
 * (Apply All Non-Conflicting Changes), "Resolve Simple Conflicts", and per-block arrows (>> / << / X).
 */
export class ThreeWayMergePanel {
	public constructor(
		private readonly gitCli: GitCliService,
		private readonly repoManager: RepositoryManager,
		private readonly scmProvider: CommitProScmProvider
	) {}

	public async openForFile(resourceUri?: vscode.Uri): Promise<void> {
		let targetUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
		const repo = targetUri
			? this.repoManager.getRepositoryForUri(targetUri)
			: this.repoManager.getActiveRepository();

		if (!repo) {
			return;
		}

		if (!targetUri) {
			const conflicts = this.scmProvider.getLatestChanges(repo.rootPath).filter(c => c.isConflicted);
			if (conflicts.length === 0) {
				vscode.window.showInformationMessage('No conflicted files detected in the repository.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				conflicts.map(c => ({ label: c.relativePath, uri: c.uri })),
				{ placeHolder: 'Select conflicted file to open in 3-Pane Merge Editor' }
			);
			if (!picked) {
				return;
			}
			targetUri = picked.uri;
		}

		const relPath = path.relative(repo.rootPath, targetUri.fsPath).replace(/\\/g, '/');
		const stages = await this.gitCli.getConflictStages(repo.rootPath, relPath);

		const baseContent = stages.baseContent || stages.workingCopyContent;
		const yoursContent = stages.yoursContent || stages.workingCopyContent;
		const theirsContent = stages.theirsContent || stages.workingCopyContent;

		let regions = Diff3Engine.computeRegions(baseContent, yoursContent, theirsContent);

		const panel = vscode.window.createWebviewPanel(
			'commitPro3WayMerge',
			`Merge Revisions: ${path.basename(relPath)}`,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		const sendState = () => {
			panel.webview.postMessage({
				type: 'state',
				relativePath: relPath,
				baseContent,
				yoursContent,
				theirsContent,
				regions,
				mergedText: Diff3Engine.buildMergedContent(regions)
			});
		};

		panel.webview.html = this.getHtml(panel.webview, relPath);

		panel.webview.onDidReceiveMessage(async msg => {
			switch (msg.type) {
				case 'ready':
					sendState();
					break;

				case 'magicWand':
					regions = Diff3Engine.applyNonConflictingChanges(regions);
					sendState();
					break;

				case 'resolveSimple':
					regions = Diff3Engine.resolveSimpleWhitespaceConflicts(regions);
					sendState();
					break;

				case 'acceptAllYours':
					await fs.writeFile(targetUri!.fsPath, yoursContent, 'utf8');
					await this.gitCli.stageFiles(repo.rootPath, [relPath]);
					await this.scmProvider.refreshRepository(repo.rootPath);
					vscode.window.showInformationMessage(`Accepted Yours (Local) for ${relPath} and marked resolved.`);
					panel.dispose();
					break;

				case 'acceptAllTheirs':
					await fs.writeFile(targetUri!.fsPath, theirsContent, 'utf8');
					await this.gitCli.stageFiles(repo.rootPath, [relPath]);
					await this.scmProvider.refreshRepository(repo.rootPath);
					vscode.window.showInformationMessage(`Accepted Theirs (Incoming) for ${relPath} and marked resolved.`);
					panel.dispose();
					break;

				case 'resolveRegion': {
					const regionId = Number(msg.regionId);
					const side = msg.side as 'yours' | 'theirs' | 'both' | 'ignore';
					regions = regions.map(r => {
						if (r.id !== regionId) {
							return r;
						}
						if (side === 'yours') {
							return { ...r, resolvedLines: [...r.yoursLines], isResolved: true };
						}
						if (side === 'theirs') {
							return { ...r, resolvedLines: [...r.theirsLines], isResolved: true };
						}
						if (side === 'both') {
							return { ...r, resolvedLines: [...r.yoursLines, ...r.theirsLines], isResolved: true };
						}
						return { ...r, resolvedLines: [], isResolved: true };
					});
					sendState();
					break;
				}

				case 'applyResult': {
					const finalContent = typeof msg.mergedText === 'string'
						? msg.mergedText
						: Diff3Engine.buildMergedContent(regions);
					await fs.writeFile(targetUri!.fsPath, finalContent, 'utf8');
					await this.gitCli.stageFiles(repo.rootPath, [relPath]);
					await this.scmProvider.refreshRepository(repo.rootPath);
					vscode.window.showInformationMessage(`Merged result saved and staged for '${relPath}'.`);
					panel.dispose();
					break;
				}
			}
		});
	}

	private getHtml(webview: vscode.Webview, relPath: string): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body {
		margin: 0;
		padding: 0;
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: var(--vscode-editorWidget-background);
		border-bottom: 1px solid var(--vscode-panel-border, #333);
		gap: 8px;
		flex-wrap: wrap;
	}
	.toolbar-group {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		border-radius: 3px;
		padding: 5px 10px;
		cursor: pointer;
		font-size: 12px;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}
	.panes-header {
		display: grid;
		grid-template-columns: 1fr 1.25fr 1fr;
		background: var(--vscode-sideBarSectionHeader-background, #252526);
		border-bottom: 1px solid var(--vscode-panel-border, #333);
		font-size: 12px;
		font-weight: 600;
	}
	.panes-header div {
		padding: 6px 10px;
		border-right: 1px solid var(--vscode-panel-border, #333);
	}
	.main-split {
		display: grid;
		grid-template-columns: 1fr 1.25fr 1fr;
		flex: 1;
		overflow: hidden;
	}
	.pane {
		overflow: auto;
		border-right: 1px solid var(--vscode-panel-border, #333);
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12.5px;
		padding: 6px;
	}
	textarea#centerEditor {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		background: var(--vscode-editor-background);
		color: var(--vscode-editor-foreground);
		border: none;
		outline: none;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12.5px;
		resize: none;
		line-height: 1.45;
	}
	.region-card {
		border: 1px solid var(--vscode-panel-border, #444);
		border-radius: 4px;
		margin-bottom: 6px;
		padding: 4px 6px;
		white-space: pre-wrap;
		line-height: 1.4;
	}
	.region-conflict {
		border-color: #e5534b;
		background: rgba(229, 83, 75, 0.12);
	}
	.region-delta {
		border-color: #388bfd;
		background: rgba(56, 139, 253, 0.12);
	}
	.region-resolved {
		border-color: #2ea043;
		background: rgba(46, 160, 67, 0.10);
	}
	.region-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 4px;
		font-size: 11px;
	}
	.mini-btn {
		padding: 2px 6px;
		font-size: 11px;
	}
</style>
</head>
<body>
	<div class="toolbar">
		<div class="toolbar-group">
			<strong>3-Pane Conflict Resolver: ${relPath}</strong>
			<span id="conflictCounter" style="font-size:12px;opacity:0.85;"></span>
		</div>
		<div class="toolbar-group">
			<button id="magicWandBtn" title="Apply all non-conflicting changes from Left & Right onto Base">✨ Magic Wand (Apply Non-Conflicting)</button>
			<button class="secondary" id="simpleResolveBtn" title="Auto-resolve whitespace-only conflicts">Resolve Simple Conflicts</button>
			<button class="secondary" id="acceptYoursBtn">Accept All Yours</button>
			<button class="secondary" id="acceptTheirsBtn">Accept All Theirs</button>
			<button id="applyBtn">✔ Apply Changes & Mark Resolved</button>
		</div>
	</div>

	<div class="panes-header">
		<div>Left: Yours (Local / HEAD) — Read Only</div>
		<div>Center: Result (Editable Merged Output from Base)</div>
		<div>Right: Theirs (Incoming / MERGE_HEAD) — Read Only</div>
	</div>

	<div class="main-split">
		<div class="pane" id="leftPane"></div>
		<div class="pane" id="centerPane" style="padding:0;">
			<textarea id="centerEditor" spellcheck="false"></textarea>
		</div>
		<div class="pane" id="rightPane"></div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const leftPane = document.getElementById('leftPane');
		const centerEditor = document.getElementById('centerEditor');
		const rightPane = document.getElementById('rightPane');
		const conflictCounter = document.getElementById('conflictCounter');

		let isSyncingScroll = false;
		function syncScroll(source, targets) {
			source.addEventListener('scroll', () => {
				if (isSyncingScroll) return;
				isSyncingScroll = true;
				const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
				targets.forEach(t => {
					t.scrollTop = ratio * Math.max(0, t.scrollHeight - t.clientHeight);
				});
				requestAnimationFrame(() => { isSyncingScroll = false; });
			});
		}
		syncScroll(leftPane, [centerEditor, rightPane]);
		syncScroll(centerEditor, [leftPane, rightPane]);
		syncScroll(rightPane, [leftPane, centerEditor]);

		document.getElementById('magicWandBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'magicWand' });
		});
		document.getElementById('simpleResolveBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'resolveSimple' });
		});
		document.getElementById('acceptYoursBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'acceptAllYours' });
		});
		document.getElementById('acceptTheirsBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'acceptAllTheirs' });
		});
		document.getElementById('applyBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'applyResult', mergedText: centerEditor.value });
		});

		function renderRegions(regions) {
			leftPane.innerHTML = '';
			rightPane.innerHTML = '';
			let unresolvedConflicts = 0;
			let pendingNonConflicting = 0;

			regions.forEach(r => {
				if (r.type === 'conflict' && !r.isResolved) unresolvedConflicts++;
				if (r.type === 'clean' && !r.isResolved) pendingNonConflicting++;

				const cls = r.isResolved
					? (r.changeSource === 'unchanged' ? '' : 'region-resolved')
					: (r.type === 'conflict' ? 'region-conflict' : 'region-delta');

				const leftCard = document.createElement('div');
				leftCard.className = 'region-card ' + cls;
				if (r.changeSource !== 'unchanged') {
					const bar = document.createElement('div');
					bar.className = 'region-actions';
					bar.innerHTML = '<span>#' + r.id + ' (' + (r.type === 'conflict' ? 'Conflict' : 'Delta') + ')</span>' +
						'<div><button class="mini-btn" data-id="' + r.id + '" data-side="yours">Accept Left &gt;&gt;</button> ' +
						'<button class="mini-btn secondary" data-id="' + r.id + '" data-side="ignore">✕</button></div>';
					leftCard.appendChild(bar);
				}
				const leftCode = document.createElement('div');
				leftCode.textContent = r.yoursLines.join('\\n');
				leftCard.appendChild(leftCode);
				leftPane.appendChild(leftCard);

				const rightCard = document.createElement('div');
				rightCard.className = 'region-card ' + cls;
				if (r.changeSource !== 'unchanged') {
					const bar = document.createElement('div');
					bar.className = 'region-actions';
					bar.innerHTML = '<div><button class="mini-btn" data-id="' + r.id + '" data-side="theirs">&lt;&lt; Accept Right</button> ' +
						'<button class="mini-btn secondary" data-id="' + r.id + '" data-side="both">Both</button></div>' +
						'<span>#' + r.id + '</span>';
					rightCard.appendChild(bar);
				}
				const rightCode = document.createElement('div');
				rightCode.textContent = r.theirsLines.join('\\n');
				rightCard.appendChild(rightCode);
				rightPane.appendChild(rightCard);
			});

			document.querySelectorAll('button[data-id]').forEach(btn => {
				btn.addEventListener('click', () => {
					vscode.postMessage({
						type: 'resolveRegion',
						regionId: btn.getAttribute('data-id'),
						side: btn.getAttribute('data-side')
					});
				});
			});

			conflictCounter.textContent =
				'Unresolved Conflicts: ' + unresolvedConflicts +
				' | Non-Conflicting Deltas: ' + pendingNonConflicting;
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'state') {
				centerEditor.value = msg.mergedText;
				renderRegions(msg.regions);
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
