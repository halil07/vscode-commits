import { describe, it, expect } from 'vitest';
import { Diff3Engine } from '../modules/branches/diff3Engine';

describe('Diff3Engine — 3-Way Merge & Conflict Resolution Engine', () => {
	it('computes unchanged regions when Base, Yours, and Theirs are identical', () => {
		const base = 'const a = 1;\nconst b = 2;';
		const regions = Diff3Engine.computeRegions(base, base, base);
		expect(regions.length).toBe(1);
		expect(regions[0].type).toBe('clean');
		expect(regions[0].changeSource).toBe('unchanged');
		expect(regions[0].isResolved).toBe(true);
		expect(Diff3Engine.buildMergedContent(regions)).toBe(base);
	});

	it('detects non-conflicting left (Yours) and right (Theirs) deltas and applies them with Magic Wand', () => {
		const base = 'line1\nline2\nline3';
		const yours = 'line1_modified_by_yours\nline2\nline3';
		const theirs = 'line1\nline2\nline3_modified_by_theirs';

		const regions = Diff3Engine.computeRegions(base, yours, theirs);
		const leftDelta = regions.find(r => r.changeSource === 'yours');
		const rightDelta = regions.find(r => r.changeSource === 'theirs');
		expect(leftDelta).toBeDefined();
		expect(leftDelta?.type).toBe('clean');
		expect(rightDelta).toBeDefined();
		expect(rightDelta?.type).toBe('clean');

		const afterWand = Diff3Engine.applyNonConflictingChanges(regions);
		const merged = Diff3Engine.buildMergedContent(afterWand);
		expect(merged).toBe('line1_modified_by_yours\nline2\nline3_modified_by_theirs');
	});

	it('auto-resolves when both Yours and Theirs make the exact same modification', () => {
		const base = 'version = 1';
		const yours = 'version = 2';
		const theirs = 'version = 2';

		const regions = Diff3Engine.computeRegions(base, yours, theirs);
		expect(regions[0].type).toBe('clean');
		expect(regions[0].changeSource).toBe('both-identical');
		expect(regions[0].isResolved).toBe(true);
		expect(Diff3Engine.buildMergedContent(regions)).toBe('version = 2');
	});

	it('detects true 3-way conflict when Yours and Theirs modify the same line differently', () => {
		const base = 'port = 3000';
		const yours = 'port = 4000';
		const theirs = 'port = 5000';

		const regions = Diff3Engine.computeRegions(base, yours, theirs);
		expect(regions.length).toBe(1);
		expect(regions[0].type).toBe('conflict');
		expect(regions[0].isResolved).toBe(false);

		// Magic wand must not overwrite true conflicts
		const afterWand = Diff3Engine.applyNonConflictingChanges(regions);
		expect(afterWand[0].isResolved).toBe(false);
	});

	it('resolves simple whitespace-only conflicts via resolveSimpleWhitespaceConflicts', () => {
		const base = 'return 1;';
		const yours = '  return 1;';
		const theirs = '\treturn 1;   ';

		const regions = Diff3Engine.computeRegions(base, yours, theirs);
		expect(regions[0].type).toBe('conflict');

		const resolved = Diff3Engine.resolveSimpleWhitespaceConflicts(regions);
		expect(resolved[0].isResolved).toBe(true);
		expect(Diff3Engine.buildMergedContent(resolved)).toBe(yours);
	});
});
