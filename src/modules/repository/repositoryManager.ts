import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GitCliService } from '../../core/gitCliService';
import { GitRepositoryRoot, SubmoduleInfo } from '../../core/types';

export class RepositoryTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly itemType: 'repository' | 'submodule' | 'remote',
		public readonly repoRoot: string,
		description?: string,
		tooltip?: string,
		iconId?: string
	) {
		super(label, collapsibleState);
		this.description = description;
		this.tooltip = tooltip;
		this.contextValue = itemType;
		if (iconId) {
			this.iconPath = new vscode.ThemeIcon(iconId);
		}
	}
}

/**
 * Manages Multi-Root Repository Discovery, Directory Mappings,
 * Synchronous Multi-Root Branch Operations, Submodules, Remotes, and 3-Tier .gitignore / exclude rules.
 */
export class RepositoryManager implements vscode.TreeDataProvider<RepositoryTreeItem>, vscode.Disposable {
	private readonly repositories = new Map<string, GitRepositoryRoot>();
	private readonly submodulesByRepo = new Map<string, SubmoduleInfo[]>();
	private activeRepoRoot?: string;

	private readonly _onDidChangeRepositories = new vscode.EventEmitter<void>();
	public readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<RepositoryTreeItem | undefined | void>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitCli: GitCliService) {}

	public getRepositories(): GitRepositoryRoot[] {
		return Array.from(this.repositories.values());
	}

	public getActiveRepository(): GitRepositoryRoot | undefined {
		const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
		if (activeEditorUri) {
			const matched = this.getRepositoryForUri(activeEditorUri);
			if (matched) {
				this.activeRepoRoot = matched.rootPath;
				return matched;
			}
		}
		if (this.activeRepoRoot && this.repositories.has(this.activeRepoRoot)) {
			return this.repositories.get(this.activeRepoRoot);
		}
		return this.getRepositories()[0];
	}

	public setActiveRepository(repoRoot: string): void {
		if (this.repositories.has(repoRoot)) {
			this.activeRepoRoot = repoRoot;
			this._onDidChangeRepositories.fire();
		}
	}

	public getRepositoryForUri(uri: vscode.Uri): GitRepositoryRoot | undefined {
		const fsPath = path.normalize(uri.fsPath);
		let bestMatch: GitRepositoryRoot | undefined;
		for (const repo of this.repositories.values()) {
			const normRoot = path.normalize(repo.rootPath);
			if (fsPath === normRoot || fsPath.startsWith(normRoot + path.sep)) {
				if (!bestMatch || normRoot.length > bestMatch.rootPath.length) {
					bestMatch = repo;
				}
			}
		}
		return bestMatch ?? this.getRepositories()[0];
	}

	public async discoverRepositories(): Promise<void> {
		const discoveredPaths = new Set<string>();
		const explicitMappings = vscode.workspace
			.getConfiguration('commitPro')
			.get<string[]>('directoryMappings', []);

		for (const mapping of explicitMappings) {
			if (await this.hasGitMarker(mapping)) {
				discoveredPaths.add(path.normalize(mapping));
			}
		}

		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of workspaceFolders) {
			await this.scanDirectoryForGitRoots(folder.uri.fsPath, 0, 2, discoveredPaths);
		}

		this.repositories.clear();
		this.submodulesByRepo.clear();

		for (const rootPath of discoveredPaths) {
			try {
				const status = await this.gitCli.getRepositoryStatus(rootPath);
				const submodules = await this.gitCli.getSubmodules(rootPath);
				this.submodulesByRepo.set(rootPath, submodules);

				const isExplicit = explicitMappings.some(m => path.normalize(m) === rootPath);
				this.repositories.set(rootPath, {
					rootPath,
					rootUri: vscode.Uri.file(rootPath),
					name: path.basename(rootPath),
					isExplicitMapping: isExplicit,
					isSubmodule: false,
					currentBranch: status.branch,
					upstreamBranch: status.upstream,
					ahead: status.ahead,
					behind: status.behind,
					isDetachedHead: status.isDetached
				});
			} catch {
				// Ignore invalid or inaccessible repository roots
			}
		}

		if (!this.activeRepoRoot && this.repositories.size > 0) {
			this.activeRepoRoot = this.getRepositories()[0].rootPath;
		} else if (this.repositories.size === 0) {
			this.activeRepoRoot = undefined;
		}

		void vscode.commands.executeCommand('setContext', 'commitPro.hasRepository', this.repositories.size > 0);
		this._onDidChangeRepositories.fire();
		this._onDidChangeTreeData.fire();
	}

	private async scanDirectoryForGitRoots(
		dirPath: string,
		depth: number,
		maxDepth: number,
		results: Set<string>
	): Promise<void> {
		if (await this.hasGitMarker(dirPath)) {
			results.add(path.normalize(dirPath));
		}
		if (depth >= maxDepth) {
			return;
		}

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				if (
					entry.name === '.git' ||
					entry.name === 'node_modules' ||
					entry.name === 'out' ||
					entry.name === 'dist' ||
					entry.name === 'vscode-api' ||
					entry.name === 'vscode-extension-samples'
				) {
					continue;
				}
				await this.scanDirectoryForGitRoots(path.join(dirPath, entry.name), depth + 1, maxDepth, results);
			}
		} catch {
			// Ignore permission errors during scan
		}
	}

	private async hasGitMarker(dirPath: string): Promise<boolean> {
		try {
			await fs.access(path.join(dirPath, '.git'));
			return true;
		} catch {
			return false;
		}
	}

	public isSynchronousBranchControlEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('commitPro')
			.get<boolean>('synchronousBranchControl', true);
	}

	public async executeAcrossTargetRepositories(
		primaryRepoRoot: string,
		operationName: string,
		action: (repoRoot: string) => Promise<void>
	): Promise<void> {
		const targets =
			this.isSynchronousBranchControlEnabled() && this.repositories.size > 1
				? this.getRepositories().map(r => r.rootPath)
				: [primaryRepoRoot];

		const completed: string[] = [];
		try {
			for (const root of targets) {
				await action(root);
				completed.push(root);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(
				`Multi-root ${operationName} halted on repository (${completed.length}/${targets.length} succeeded): ${message}`
			);
			throw err;
		} finally {
			await this.discoverRepositories();
		}
	}

	public async manageDirectoryMappingsInteractive(): Promise<void> {
		const config = vscode.workspace.getConfiguration('commitPro');
		const currentMappings = config.get<string[]>('directoryMappings', []);

		const action = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Add Directory Mapping...', id: 'add', description: 'Register an external or nested Git root' },
				{ label: '$(sync) Toggle Synchronous Multi-Root Branch Control', id: 'sync', description: `Currently: ${this.isSynchronousBranchControlEnabled() ? 'Enabled' : 'Disabled'}` },
				...currentMappings.map(m => ({
					label: `$(trash) Remove Mapping: ${path.basename(m)}`,
					id: `remove:${m}`,
					description: m
				}))
			],
			{ placeHolder: 'Manage VCS Directory Mappings (Multi-Root)' }
		);

		if (!action) {
			return;
		}

		if (action.id === 'add') {
			const selected = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Register Git Repository Root'
			});
			if (selected && selected[0]) {
				const folderPath = selected[0].fsPath;
				if (!(await this.hasGitMarker(folderPath))) {
					const initChoice = await vscode.window.showWarningMessage(
						`'${folderPath}' does not contain a .git directory. Initialize a new Git repository there?`,
						'Initialize (git init)',
						'Cancel'
					);
					if (initChoice === 'Initialize (git init)') {
						await this.gitCli.initRepository(folderPath);
					} else {
						return;
					}
				}
				const next = Array.from(new Set([...currentMappings, folderPath]));
				await config.update('directoryMappings', next, vscode.ConfigurationTarget.Workspace);
				await this.discoverRepositories();
			}
		} else if (action.id === 'sync') {
			const current = this.isSynchronousBranchControlEnabled();
			await config.update('synchronousBranchControl', !current, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(
				`Execute branch operations on all roots is now ${!current ? 'Enabled' : 'Disabled'}.`
			);
			this._onDidChangeTreeData.fire();
		} else if (action.id.startsWith('remove:')) {
			const target = action.id.slice('remove:'.length);
			const next = currentMappings.filter(m => m !== target);
			await config.update('directoryMappings', next, vscode.ConfigurationTarget.Workspace);
			await this.discoverRepositories();
		}
	}

	public async createGitRepositoryInteractive(): Promise<void> {
		const selected = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Create Git Repository Here'
		});
		if (!selected || !selected[0]) {
			return;
		}
		const targetPath = selected[0].fsPath;
		await this.gitCli.initRepository(targetPath);

		const gitignorePath = path.join(targetPath, '.gitignore');
		try {
			await fs.access(gitignorePath);
		} catch {
			const addIgnore = await vscode.window.showInformationMessage(
				'Git repository initialized. Create standard .gitignore?',
				'Create .gitignore',
				'Skip'
			);
			if (addIgnore === 'Create .gitignore') {
				await fs.writeFile(
					gitignorePath,
					'# Local workspace & build state\n.vscode/commit-pro/\nnode_modules/\nout/\n.DS_Store\n',
					'utf8'
				);
			}
		}

		await this.discoverRepositories();
		vscode.window.showInformationMessage(`Initialized Git repository in ${targetPath}`);
	}

	public async addToGitignoreInteractive(resourceUri?: vscode.Uri): Promise<void> {
		const targetUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!targetUri) {
			vscode.window.showWarningMessage('Select a file or open an editor to add to .gitignore / exclude.');
			return;
		}

		const repo = this.getRepositoryForUri(targetUri);
		if (!repo) {
			return;
		}

		const relPath = path.relative(repo.rootPath, targetUri.fsPath).replace(/\\/g, '/');
		const parentDir = path.dirname(targetUri.fsPath);
		const fileName = path.basename(targetUri.fsPath);

		const tierPick = await vscode.window.showQuickPick(
			[
				{
					label: '$(file-code) 1. Project Root .gitignore',
					id: 'root',
					description: path.join(repo.rootPath, '.gitignore'),
					detail: `Shared team rule: adds '${relPath}' to repository root .gitignore`
				},
				{
					label: '$(folder) 2. Module / Directory Level .gitignore',
					id: 'dir',
					description: path.join(parentDir, '.gitignore'),
					detail: `Scoped directory rule: adds '${fileName}' to ${path.relative(repo.rootPath, parentDir) || '.'}/.gitignore`
				},
				{
					label: '$(lock) 3. Local Repository .git/info/exclude',
					id: 'exclude',
					description: path.join(repo.rootPath, '.git', 'info', 'exclude'),
					detail: `Private machine-only exclusion: never pushed to remote`
				}
			],
			{ placeHolder: `Choose exclusion layer for '${relPath}'` }
		);

		if (!tierPick) {
			return;
		}

		const pattern = await vscode.window.showInputBox({
			prompt: 'Confirm or customize ignore pattern',
			value: tierPick.id === 'dir' ? fileName : relPath
		});
		if (!pattern) {
			return;
		}

		let targetIgnoreFile: string;
		if (tierPick.id === 'root') {
			targetIgnoreFile = path.join(repo.rootPath, '.gitignore');
		} else if (tierPick.id === 'dir') {
			targetIgnoreFile = path.join(parentDir, '.gitignore');
		} else {
			targetIgnoreFile = path.join(repo.rootPath, '.git', 'info', 'exclude');
		}

		await fs.mkdir(path.dirname(targetIgnoreFile), { recursive: true });
		let existing: string;
		try {
			existing = await fs.readFile(targetIgnoreFile, 'utf8');
		} catch {
			existing = '';
		}

		const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
		await fs.writeFile(targetIgnoreFile, `${existing}${prefix}${pattern}\n`, 'utf8');

		await this.gitCli.untrackFileKeepingWorkingCopy(repo.rootPath, relPath);
		vscode.window.showInformationMessage(`Added '${pattern}' to ${path.basename(targetIgnoreFile)} and untracked from Git index.`);
		this._onDidChangeRepositories.fire();
	}

	public async manageRemotesInteractive(): Promise<void> {
		const repo = this.getActiveRepository();
		if (!repo) {
			return;
		}

		const remotes = await this.gitCli.getRemotes(repo.rootPath);
		const pick = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Add New Remote...', id: 'add', description: 'Define origin, upstream, or custom remote URL' },
				...remotes.map(r => ({
					label: `$(remote) ${r.name}`,
					id: `remote:${r.name}`,
					description: r.fetchUrl,
					detail: `Push URL: ${r.pushUrl} (Select to remove)`
				}))
			],
			{ placeHolder: `Manage Remotes for ${repo.name}` }
		);

		if (!pick) {
			return;
		}

		if (pick.id === 'add') {
			const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: remotes.length === 0 ? 'origin' : 'upstream' });
			if (!name) {
				return;
			}
			const url = await vscode.window.showInputBox({ prompt: `Remote URL for '${name}'`, placeHolder: 'https://github.com/org/repo.git or git@github.com:org/repo.git' });
			if (!url) {
				return;
			}
			await this.gitCli.addRemote(repo.rootPath, name.trim(), url.trim());
			vscode.window.showInformationMessage(`Added remote '${name}' -> ${url}`);
		} else if (pick.id.startsWith('remote:')) {
			const remoteName = pick.id.slice('remote:'.length);
			const confirm = await vscode.window.showWarningMessage(`Remove remote '${remoteName}'?`, 'Remove', 'Cancel');
			if (confirm === 'Remove') {
				await this.gitCli.removeRemote(repo.rootPath, remoteName);
				vscode.window.showInformationMessage(`Removed remote '${remoteName}'.`);
			}
		}
		this._onDidChangeTreeData.fire();
	}

	public getTreeItem(element: RepositoryTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: RepositoryTreeItem): Promise<RepositoryTreeItem[]> {
		if (!element) {
			const items: RepositoryTreeItem[] = [];
			for (const repo of this.repositories.values()) {
				const syncBadge = this.isSynchronousBranchControlEnabled() && this.repositories.size > 1 ? ' [Sync]' : '';
				const desc = `${repo.currentBranch} (↑${repo.ahead} ↓${repo.behind})${syncBadge}`;
				items.push(
					new RepositoryTreeItem(
						repo.name,
						vscode.TreeItemCollapsibleState.Expanded,
						'repository',
						repo.rootPath,
						desc,
						`Root: ${repo.rootPath}`,
						repo.isDetachedHead ? 'warning' : 'repo'
					)
				);
			}
			return items;
		}

		if (element.itemType === 'repository') {
			const children: RepositoryTreeItem[] = [];
			const submodules = this.submodulesByRepo.get(element.repoRoot) ?? [];
			for (const sub of submodules) {
				children.push(
					new RepositoryTreeItem(
						`Submodule: ${sub.relativePath}`,
						vscode.TreeItemCollapsibleState.None,
						'submodule',
						element.repoRoot,
						`${sub.sha} (${sub.branchOrTag})`,
						sub.isDetached ? 'Detached HEAD submodule' : sub.fullPath,
						sub.isDetached ? 'warning' : 'file-submodule'
					)
				);
			}

			try {
				const remotes = await this.gitCli.getRemotes(element.repoRoot);
				for (const remote of remotes) {
					children.push(
						new RepositoryTreeItem(
							`Remote: ${remote.name}`,
							vscode.TreeItemCollapsibleState.None,
							'remote',
							element.repoRoot,
							remote.fetchUrl,
							`Fetch: ${remote.fetchUrl}\nPush: ${remote.pushUrl}`,
							'remote'
						)
					);
				}
			} catch {
				// Ignore remote listing error
			}
			return children;
		}

		return [];
	}

	public dispose(): void {
		this._onDidChangeRepositories.dispose();
		this._onDidChangeTreeData.dispose();
	}
}
