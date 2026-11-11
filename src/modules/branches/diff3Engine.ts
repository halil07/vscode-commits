import { Diff3Region } from '../../core/types';

/**
 * Deterministic 3-Way Merge (diff3) Engine for the 3-Pane Conflict Resolver.
 * Computes aligned regions across Base, Yours (Local), and Theirs (Incoming),
 * powering the "Magic Wand" (Apply All Non-Conflicting Changes) and "Resolve Simple Conflicts".
 */
export class Diff3Engine {
	public static computeRegions(
		baseText: string,
		yoursText: string,
		theirsText: string
	): Diff3Region[] {
		const baseLines = baseText.split(/\r?\n/);
		const yoursLines = yoursText.split(/\r?\n/);
		const theirsLines = theirsText.split(/\r?\n/);

		const regions: Diff3Region[] = [];
		let iBase = 0;
		let iYours = 0;
		let iTheirs = 0;
		let regionId = 1;

		while (iBase < baseLines.length || iYours < yoursLines.length || iTheirs < theirsLines.length) {
			const bLine = baseLines[iBase];
			const yLine = yoursLines[iYours];
			const tLine = theirsLines[iTheirs];

			if (
				iBase < baseLines.length &&
				iYours < yoursLines.length &&
				iTheirs < theirsLines.length &&
				bLine === yLine &&
				bLine === tLine
			) {
				const cleanBase: string[] = [];
				while (
					iBase < baseLines.length &&
					iYours < yoursLines.length &&
					iTheirs < theirsLines.length &&
					baseLines[iBase] === yoursLines[iYours] &&
					baseLines[iBase] === theirsLines[iTheirs]
				) {
					cleanBase.push(baseLines[iBase]);
					iBase++;
					iYours++;
					iTheirs++;
				}
				regions.push({
					id: regionId++,
					type: 'clean',
					changeSource: 'unchanged',
					baseLines: cleanBase,
					yoursLines: [...cleanBase],
					theirsLines: [...cleanBase],
					resolvedLines: [...cleanBase],
					isResolved: true
				});
				continue;
			}

			const anchor = this.findNextSyncAnchor(baseLines, yoursLines, theirsLines, iBase, iYours, iTheirs);
			const bChunk = baseLines.slice(iBase, anchor.nextBase);
			const yChunk = yoursLines.slice(iYours, anchor.nextYours);
			const tChunk = theirsLines.slice(iTheirs, anchor.nextTheirs);

			iBase = anchor.nextBase;
			iYours = anchor.nextYours;
			iTheirs = anchor.nextTheirs;

			const bJoined = bChunk.join('\n');
			const yJoined = yChunk.join('\n');
			const tJoined = tChunk.join('\n');

			if (yJoined === tJoined) {
				regions.push({
					id: regionId++,
					type: 'clean',
					changeSource: 'both-identical',
					baseLines: bChunk,
					yoursLines: yChunk,
					theirsLines: tChunk,
					resolvedLines: [...yChunk],
					isResolved: true
				});
			} else if (bJoined === yJoined && bJoined !== tJoined) {
				regions.push({
					id: regionId++,
					type: 'clean',
					changeSource: 'theirs',
					baseLines: bChunk,
					yoursLines: yChunk,
					theirsLines: tChunk,
					resolvedLines: [...bChunk],
					isResolved: false
				});
			} else if (bJoined === tJoined && bJoined !== yJoined) {
				regions.push({
					id: regionId++,
					type: 'clean',
					changeSource: 'yours',
					baseLines: bChunk,
					yoursLines: yChunk,
					theirsLines: tChunk,
					resolvedLines: [...bChunk],
					isResolved: false
				});
			} else {
				regions.push({
					id: regionId++,
					type: 'conflict',
					baseLines: bChunk,
					yoursLines: yChunk,
					theirsLines: tChunk,
					resolvedLines: [...bChunk],
					isResolved: false
				});
			}
		}

		return regions;
	}

	public static applyNonConflictingChanges(regions: Diff3Region[]): Diff3Region[] {
		return regions.map(r => {
			if (r.type === 'clean' && !r.isResolved) {
				if (r.changeSource === 'yours') {
					return { ...r, resolvedLines: [...r.yoursLines], isResolved: true };
				}
				if (r.changeSource === 'theirs') {
					return { ...r, resolvedLines: [...r.theirsLines], isResolved: true };
				}
			}
			return r;
		});
	}

	public static resolveSimpleWhitespaceConflicts(regions: Diff3Region[]): Diff3Region[] {
		return regions.map(r => {
			if (r.type === 'conflict' && !r.isResolved) {
				const normY = r.yoursLines.map(l => l.trim()).join('\n');
				const normT = r.theirsLines.map(l => l.trim()).join('\n');
				if (normY === normT) {
					return { ...r, resolvedLines: [...r.yoursLines], isResolved: true };
				}
			}
			return r;
		});
	}

	public static buildMergedContent(regions: Diff3Region[]): string {
		const lines: string[] = [];
		for (const r of regions) {
			lines.push(...r.resolvedLines);
		}
		return lines.join('\n');
	}

	private static findNextSyncAnchor(
		baseLines: string[],
		yoursLines: string[],
		theirsLines: string[],
		startB: number,
		startY: number,
		startT: number
	): { nextBase: number; nextYours: number; nextTheirs: number } {
		const maxLookahead = 60;
		for (let offsetB = 0; offsetB < maxLookahead && startB + offsetB < baseLines.length; offsetB++) {
			const candidate = baseLines[startB + offsetB];
			if (!candidate.trim()) {
				continue;
			}
			const yIdx = this.indexOfWithin(yoursLines, candidate, startY, maxLookahead);
			const tIdx = this.indexOfWithin(theirsLines, candidate, startT, maxLookahead);
			if (yIdx !== -1 && tIdx !== -1 && (offsetB > 0 || yIdx > startY || tIdx > startT)) {
				return {
					nextBase: startB + offsetB,
					nextYours: yIdx,
					nextTheirs: tIdx
				};
			}
		}

		return {
			nextBase: baseLines.length,
			nextYours: yoursLines.length,
			nextTheirs: theirsLines.length
		};
	}

	private static indexOfWithin(arr: string[], target: string, fromIndex: number, limit: number): number {
		const max = Math.min(arr.length, fromIndex + limit);
		for (let i = fromIndex; i < max; i++) {
			if (arr[i] === target) {
				return i;
			}
		}
		return -1;
	}
}
