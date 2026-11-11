import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitCliService } from '../core/gitCliService';
import * as fs from 'fs/promises';

vi.mock('fs/promises', () => ({
	rm: vi.fn(async () => undefined),
	readFile: vi.fn(async () => 'working-copy-text'),
	writeFile: vi.fn(async () => undefined),
	mkdtemp: vi.fn(async () => '/tmp/commit-pro-test'),
	mkdir: vi.fn(async () => undefined),
	readdir: vi.fn(async () => []),
	stat: vi.fn(async () => ({ isDirectory: () => true }))
}));

describe('GitCliService — Low-Level Git CLI & Porcelain Parsers', () => {
	let gitCli: GitCliService;

	beforeEach(() => {
		gitCli = new GitCliService();
	});

	it('records command history and shows output console', async () => {
		const res = await gitCli.execGit(process.cwd(), ['--version']);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain('git version');
		expect(gitCli.getCommandHistory().length).toBeGreaterThan(0);
		gitCli.showConsole();
		gitCli.dispose();
	});

	it('handles non-zero exit with allowNonZeroExit and rejects when not allowed', async () => {
		const allowed = await gitCli.execGit(process.cwd(), ['rev-parse', '--verify', 'nonexistent-ref-xyz'], {
			allowNonZeroExit: true
		});
		expect(allowed.exitCode).not.toBe(0);

		await expect(
			gitCli.execGit(process.cwd(), ['rev-parse', '--verify', 'nonexistent-ref-xyz'])
		).rejects.toThrow(/Git command failed/);
	});

	it('parses getRepositoryStatus (Porcelain v2) with branch, ahead/behind, staged, rename, conflict, untracked', async () => {
		const porcelainSample = [
			'# branch.oid 1234567890abcdef',
			'# branch.head main',
			'# branch.upstream origin/main',
			'# branch.ab +3 -2',
			'1 M. N... 100644 100644 100644 aaaa bbbb src/app.ts',
			'2 R. N... 100644 100644 100644 aaaa bbbb R100 src/newName.ts\tsrc/oldName.ts',
			'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts',
			'? src/untracked.ts'
		].join('\n');

		vi.spyOn(gitCli, 'execGit').mockResolvedValueOnce({
			stdout: porcelainSample,
			stderr: '',
			exitCode: 0
		});

		const status = await gitCli.getRepositoryStatus('/repo');
		expect(status.branch).toBe('main');
		expect(status.upstream).toBe('origin/main');
		expect(status.ahead).toBe(3);
		expect(status.behind).toBe(2);
		expect(status.isDetached).toBe(false);
		expect(status.changes.length).toBe(4);

		expect(status.changes[0].relativePath).toBe('src/app.ts');
		expect(status.changes[0].isStaged).toBe(true);
		expect(status.changes[1].relativePath).toBe('src/newName.ts');
		expect(status.changes[1].originalRelativePath).toBe('src/oldName.ts');
		expect(status.changes[2].isConflicted).toBe(true);
		expect(status.changes[3].isUntracked).toBe(true);
	});

	it('parses detached HEAD state in getRepositoryStatus', async () => {
		vi.spyOn(gitCli, 'execGit').mockResolvedValueOnce({
			stdout: '# branch.head (detached)\n',
			stderr: '',
			exitCode: 0
		});
		const status = await gitCli.getRepositoryStatus('/repo');
		expect(status.isDetached).toBe(true);
		expect(status.branch).toBe('HEAD (detached)');
	});

	it('executes staging, unstaging, discarding, patch applying, commit, reword, and format-patch', async () => {
		const spy = vi.spyOn(gitCli, 'execGit').mockResolvedValue({
			stdout: 'ok-output',
			stderr: '',
			exitCode: 0
		});

		await gitCli.initRepository('/repo');
		await gitCli.stageFiles('/repo', []);
		await gitCli.stageFiles('/repo', ['a.ts']);
		await gitCli.unstageFiles('/repo', []);
		await gitCli.unstageFiles('/repo', ['a.ts']);
		await gitCli.discardFileChanges('/repo', ['a.ts'], ['untracked.ts']);
		expect(fs.rm).toHaveBeenCalled();

		await gitCli.applyPatchToIndex('/repo', 'diff --git a/a.ts b/a.ts');
		await gitCli.commit(
			'/repo',
			{
				message: 'feat: test commit',
				amend: true,
				signOff: true,
				gpgSign: true,
				author: 'Jane Doe <jane@example.com>',
				runGitHooks: false,
				optimizeImports: false,
				reformatCode: false,
				analyzeCode: false,
				checkTodo: false
			},
			['a.ts']
		);

		await gitCli.undoLastCommit('/repo');
		expect(await gitCli.getLastCommitMessage('/repo')).toBe('ok-output');
		expect(await gitCli.getCommitMessage('/repo', 'abc1234')).toBe('ok-output');
		expect(await gitCli.getHeadCommitHash('/repo')).toBe('ok-output');
		await gitCli.rewordHeadCommit('/repo', 'new message');
		expect(await gitCli.formatCommitPatch('/repo', 'abc1234')).toBe('ok-output');
		expect(await gitCli.showFullCommit('/repo', 'abc1234')).toBe('ok-output');
		await gitCli.dropSingleCommit('/repo', 'abc1234');
		await gitCli.restoreFileAtRevision('/repo', 'abc1234', 'src/a.ts');
		await gitCli.untrackFileKeepingWorkingCopy('/repo', 'secret.env');

		expect(spy).toHaveBeenCalled();
	});

	it('parses branches, protected patterns, and runs branch/tag/remote/push operations', async () => {
		const refOutput = [
			'*|main|refs/heads/main|origin/main|[ahead 2, behind 1]|a1b2c3d|Initial main commit',
			' |feature/ui|refs/heads/feature/ui|origin/feature/ui||f00ba12|UI polish',
			' |origin/main|refs/remotes/origin/main|||a1b2c3d|Initial main commit',
			' |origin/HEAD|refs/remotes/origin/HEAD|||a1b2c3d|Skip HEAD'
		].join('\n');

		const spy = vi.spyOn(gitCli, 'execGit').mockResolvedValue({
			stdout: refOutput,
			stderr: '',
			exitCode: 0
		});

		const branches = await gitCli.getBranches('/repo', ['main', 'release/*']);
		expect(branches.length).toBe(3);
		expect(branches[0].name).toBe('main');
		expect(branches[0].isCurrent).toBe(true);
		expect(branches[0].ahead).toBe(2);
		expect(branches[0].behind).toBe(1);
		expect(branches[0].isProtected).toBe(true);
		expect(branches[1].isProtected).toBe(false);
		expect(branches[2].isRemote).toBe(true);

		await gitCli.checkoutBranch('/repo', 'feature/new', true, 'main');
		await gitCli.checkoutBranch('/repo', 'main', false);
		await gitCli.deleteBranch('/repo', 'feature/old', false);
		await gitCli.deleteBranch('/repo', 'feature/old', true);
		await gitCli.renameBranch('/repo', 'old', 'new');
		await gitCli.mergeBranch('/repo', 'feature/ui');
		await gitCli.rebaseBranch('/repo', 'main');
		await gitCli.cherryPick('/repo', 'a1b2c3d');
		await gitCli.revertCommit('/repo', 'a1b2c3d');
		await gitCli.resetBranch('/repo', 'a1b2c3d', 'soft');
		await gitCli.createTag('/repo', 'v1.0.0', 'a1b2c3d', 'Release 1.0');
		await gitCli.createTag('/repo', 'v1.0.1', 'a1b2c3d');

		spy.mockResolvedValueOnce({
			stdout: 'origin\thttps://github.com/org/repo.git (fetch)\norigin\thttps://github.com/org/repo.git (push)\n',
			stderr: '',
			exitCode: 0
		});
		const remotes = await gitCli.getRemotes('/repo');
		expect(remotes.length).toBe(1);
		expect(remotes[0].name).toBe('origin');

		await gitCli.addRemote('/repo', 'upstream', 'https://github.com/up/repo.git');
		await gitCli.removeRemote('/repo', 'upstream');
		await gitCli.fetchAll('/repo');
		await gitCli.updateProject('/repo', 'merge');
		await gitCli.updateProject('/repo', 'rebase');
		await gitCli.updateProject('/repo', 'reset');

		await gitCli.push('/repo', {
			remote: 'origin',
			branch: 'main',
			forceWithLease: true,
			setUpstream: true,
			pushTags: 'all'
		});
		await gitCli.push('/repo', {
			remote: 'origin',
			branch: 'main',
			upToCommitSha: 'a1b2c3d',
			pushTags: 'follow'
		});
	});

	it('parses commit log with filters, assigns swimlanes, and parses changed files & selection history', async () => {
		const sep = '\x1f';
		const logLines = [
			`c3${sep}c3short${sep}c2 c1${sep}Alice${sep}alice@dev${sep}2026-10-20T10:00:00Z${sep}2026-10-20T10:00:00Z${sep}HEAD -> main, tag: v1.0${sep}Merge branch feat`,
			`c2${sep}c2short${sep}c1${sep}Bob${sep}bob@dev${sep}2026-10-19T10:00:00Z${sep}2026-10-19T10:00:00Z${sep}origin/feat${sep}Add feature`,
			`c1${sep}c1short${sep}${sep}Alice${sep}alice@dev${sep}2026-10-18T10:00:00Z${sep}2026-10-18T10:00:00Z${sep}${sep}Root commit`
		].join('\n');

		const spy = vi.spyOn(gitCli, 'execGit').mockResolvedValueOnce({
			stdout: logLines,
			stderr: '',
			exitCode: 0
		});

		const commits = await gitCli.getCommitLog('/repo', {
			branch: 'main',
			user: 'Alice',
			dateRange: '7days',
			searchPattern: 'feat',
			isRegex: true,
			pathFilter: 'src/index.ts',
			maxCount: 50
		});
		expect(commits.length).toBe(3);
		expect(commits[0].parents).toEqual(['c2', 'c1']);
		expect(commits[0].refs).toContain('HEAD -> main');
		expect(typeof commits[0].lane).toBe('number');

		// Test other dateRange filters
		spy.mockResolvedValueOnce({ stdout: logLines, stderr: '', exitCode: 0 });
		await gitCli.getCommitLog('/repo', { dateRange: 'today' });
		spy.mockResolvedValueOnce({ stdout: logLines, stderr: '', exitCode: 0 });
		await gitCli.getCommitLog('/repo', { dateRange: '30days' });
		spy.mockResolvedValueOnce({ stdout: logLines, stderr: '', exitCode: 0 });
		await gitCli.getCommitLog('/repo', { dateRange: '2026-01-01' });

		spy.mockResolvedValueOnce({
			stdout: 'M\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/new.ts\n',
			stderr: '',
			exitCode: 0
		});
		const deltas = await gitCli.getCommitChangedFiles('/repo', 'c3');
		expect(deltas.length).toBe(2);
		expect(deltas[1].oldRelativePath).toBe('src/old.ts');

		spy.mockResolvedValueOnce({ stdout: 'selection-history-log', stderr: '', exitCode: 0 });
		const selHist = await gitCli.getSelectionHistory('/repo', 'src/a.ts', 1, 10);
		expect(selHist).toBe('selection-history-log');
	});

	it('parses git blame (--porcelain), conflict stages, submodules, worktrees, stashes, and patches', async () => {
		const blameOutput = [
			'0123456789abcdef0123456789abcdef01234567 1 1 1',
			'author Alice Dev',
			'author-mail <alice@example.com>',
			'author-time 1700000000',
			'summary Fix bug in parser',
			'\tconst x = 42;'
		].join('\n');

		const spy = vi.spyOn(gitCli, 'execGit');
		spy.mockResolvedValueOnce({ stdout: blameOutput, stderr: '', exitCode: 0 });
		const blame = await gitCli.getFileBlame('/repo', 'src/file.ts');
		expect(blame.length).toBe(1);
		expect(blame[0].author).toBe('Alice Dev');
		expect(blame[0].summary).toBe('Fix bug in parser');

		spy.mockResolvedValue({ stdout: 'stage-content', stderr: '', exitCode: 0 });
		const stages = await gitCli.getConflictStages('/repo', 'src/conflict.ts');
		expect(stages.baseContent).toBe('stage-content');
		expect(stages.yoursContent).toBe('stage-content');
		expect(stages.theirsContent).toBe('stage-content');

		spy.mockResolvedValueOnce({
			stdout: '+abcdef1234567890 libs/sub (v1.0)\n',
			stderr: '',
			exitCode: 0
		});
		const subs = await gitCli.getSubmodules('/repo');
		expect(subs.length).toBe(1);
		expect(subs[0].isDetached).toBe(true);

		const wtOutput = [
			'worktree /repo',
			'HEAD 1111222233334444',
			'branch refs/heads/main',
			'',
			'worktree /repo-wt',
			'HEAD 5555666677778888',
			'detached',
			''
		].join('\n');
		spy.mockResolvedValueOnce({ stdout: wtOutput, stderr: '', exitCode: 0 });
		const wts = await gitCli.listWorktrees('/repo');
		expect(wts.length).toBe(2);
		expect(wts[0].isMain).toBe(true);
		expect(wts[1].branch).toBe('HEAD (detached)');

		await gitCli.addWorktree('/repo', '/repo-wt2', 'feat/wt', 'main');
		await gitCli.removeWorktree('/repo', '/repo-wt2', true);

		spy.mockResolvedValueOnce({
			stdout: 'stash@{0}|WIP on main: working\n',
			stderr: '',
			exitCode: 0
		});
		const stashes = await gitCli.listStashes('/repo');
		expect(stashes.length).toBe(1);
		expect(stashes[0].ref).toBe('stash@{0}');

		await gitCli.createStash('/repo', 'save-msg', true, true);
		await gitCli.popStash('/repo', 'stash@{0}');
		await gitCli.createDiffPatch('/repo', ['src/a.ts']);
		await gitCli.applyPatchFile('/repo', '/tmp/test.patch', true);
	});
});
