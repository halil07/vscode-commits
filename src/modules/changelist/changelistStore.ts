import * as vscode from 'vscode';
import { Changelist, GitFileChange } from '../../core/types';

const STORAGE_KEY = 'commitPro.changelistsByRepo';

/**
 * Dynamic Changelist Store.
 * Maintains the default "Changes" list alongside user-defined Changelists,
 * routes newly modified files to the Active Changelist, and persists assignments.
 */
export class ChangelistStore implements vscode.Disposable {
	private readonly listsByRepo = new Map<string, Changelist[]>();
	private readonly _onDidChangeChangelists = new vscode.EventEmitter<string>();
	public readonly onDidChangeChangelists = this._onDidChangeChangelists.event;

	constructor(private readonly workspaceState: vscode.Memento) {
		const saved = this.workspaceState.get<Record<string, Changelist[]>>(STORAGE_KEY, {});
		for (const [repoRoot, lists] of Object.entries(saved)) {
			if (Array.isArray(lists) && lists.length > 0) {
				this.listsByRepo.set(repoRoot, lists);
			}
		}
	}

	public getChangelists(repoRoot: string): Changelist[] {
		let lists = this.listsByRepo.get(repoRoot);
		if (!lists || lists.length === 0) {
			lists = [
				{
					id: 'default-changes',
					name: 'Changes',
					comment: '',
					isActive: true,
					isDefault: true,
					files: []
				}
			];
			this.listsByRepo.set(repoRoot, lists);
		}
		return lists;
	}

	public getActiveChangelist(repoRoot: string): Changelist {
		const lists = this.getChangelists(repoRoot);
		return lists.find(l => l.isActive) ?? lists[0];
	}

	public async createChangelist(repoRoot: string, name: string, comment = '', makeActive = true): Promise<Changelist> {
		const lists = this.getChangelists(repoRoot);
		const id = `changelist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		if (makeActive) {
			for (const list of lists) {
				list.isActive = false;
			}
		}
		const created: Changelist = {
			id,
			name: name.trim(),
			comment: comment.trim(),
			isActive: makeActive,
			isDefault: false,
			files: []
		};
		lists.push(created);
		await this.save(repoRoot);
		return created;
	}

	public async setActiveChangelist(repoRoot: string, changelistId: string): Promise<void> {
		const lists = this.getChangelists(repoRoot);
		for (const list of lists) {
			list.isActive = list.id === changelistId;
		}
		await this.save(repoRoot);
	}

	public async deleteChangelist(repoRoot: string, changelistId: string): Promise<void> {
		const lists = this.getChangelists(repoRoot);
		const target = lists.find(l => l.id === changelistId);
		if (!target || target.isDefault) {
			throw new Error('The default "Changes" changelist cannot be deleted.');
		}

		const defaultList = lists.find(l => l.isDefault) ?? lists[0];
		for (const file of target.files) {
			if (!defaultList.files.includes(file)) {
				defaultList.files.push(file);
			}
		}
		if (target.isActive) {
			defaultList.isActive = true;
		}

		const remaining = lists.filter(l => l.id !== changelistId);
		this.listsByRepo.set(repoRoot, remaining);
		await this.save(repoRoot);
	}

	public async moveFilesToChangelist(repoRoot: string, relativePaths: string[], targetChangelistId: string): Promise<void> {
		const lists = this.getChangelists(repoRoot);
		const target = lists.find(l => l.id === targetChangelistId);
		if (!target) {
			return;
		}

		const normalizedPaths = relativePaths.map(p => p.replace(/\\/g, '/'));
		for (const list of lists) {
			list.files = list.files.filter(f => !normalizedPaths.includes(f));
		}
		for (const relPath of normalizedPaths) {
			if (!target.files.includes(relPath)) {
				target.files.push(relPath);
			}
		}

		await this.save(repoRoot);
	}

	public async reconcileChanges(repoRoot: string, currentChanges: GitFileChange[]): Promise<void> {
		const lists = this.getChangelists(repoRoot);
		const activeList = this.getActiveChangelist(repoRoot);

		const trackedChangedPaths = new Set(
			currentChanges
				.filter(c => !c.isUntracked && !c.isConflicted)
				.map(c => c.relativePath.replace(/\\/g, '/'))
		);

		const assignedAnywhere = new Set<string>();
		for (const list of lists) {
			list.files = list.files.filter(f => trackedChangedPaths.has(f));
			for (const f of list.files) {
				assignedAnywhere.add(f);
			}
		}

		for (const relPath of trackedChangedPaths) {
			if (!assignedAnywhere.has(relPath)) {
				activeList.files.push(relPath);
			}
		}

		await this.persistStateOnly();
	}

	private async save(repoRoot: string): Promise<void> {
		await this.persistStateOnly();
		this._onDidChangeChangelists.fire(repoRoot);
	}

	private async persistStateOnly(): Promise<void> {
		const plain: Record<string, Changelist[]> = {};
		for (const [root, lists] of this.listsByRepo.entries()) {
			plain[root] = lists;
		}
		await this.workspaceState.update(STORAGE_KEY, plain);
	}

	public dispose(): void {
		this._onDidChangeChangelists.dispose();
	}
}
