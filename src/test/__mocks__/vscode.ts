import { vi } from 'vitest';

export class EventEmitter<T> {
	private listeners: ((e: T) => unknown)[] = [];

	public readonly event = (listener: (e: T) => unknown) => {
		this.listeners.push(listener);
		return {
			dispose: () => {
				this.listeners = this.listeners.filter(l => l !== listener);
			}
		};
	};

	public fire(data: T): void {
		for (const listener of [...this.listeners]) {
			listener(data);
		}
	}

	public dispose(): void {
		this.listeners = [];
	}
}

export class Uri {
	public readonly scheme: string;
	public readonly fsPath: string;
	public readonly path: string;
	public readonly query: string;

	private constructor(scheme: string, fsPath: string, query = '') {
		this.scheme = scheme;
		this.fsPath = fsPath;
		this.path = fsPath.replace(/\\/g, '/');
		this.query = query;
	}

	public static file(fsPath: string): Uri {
		return new Uri('file', fsPath);
	}

	public static parse(value: string): Uri {
		return new Uri('file', value);
	}

	public with(change: { scheme?: string; path?: string; query?: string }): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.path ?? this.fsPath,
			change.query ?? this.query
		);
	}

	public toString(): string {
		return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`;
	}
}

export class Position {
	constructor(
		public readonly line: number,
		public readonly character: number
	) {}
}

export class Range {
	public readonly start: Position;
	public readonly end: Position;

	constructor(
		startLineOrPos: number | Position,
		startCharOrEndPos: number | Position,
		endLine?: number,
		endChar?: number
	) {
		if (typeof startLineOrPos === 'number' && typeof startCharOrEndPos === 'number') {
			this.start = new Position(startLineOrPos, startCharOrEndPos);
			this.end = new Position(endLine ?? startLineOrPos, endChar ?? startCharOrEndPos);
		} else {
			this.start = startLineOrPos as Position;
			this.end = startCharOrEndPos as Position;
		}
	}
}

export class Selection extends Range {
	public readonly anchor: Position;
	public readonly active: Position;
	public readonly isEmpty: boolean;

	constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
		super(startLine, startChar, endLine, endChar);
		this.anchor = this.start;
		this.active = this.end;
		this.isEmpty = startLine === endLine && startChar === endChar;
	}
}

export class ThemeIcon {
	constructor(public readonly id: string) {}
}

export class ThemeColor {
	constructor(public readonly id: string) {}
}

export class MarkdownString {
	public value = '';
	public isTrusted = false;

	constructor(value = '') {
		this.value = value;
	}

	public appendMarkdown(str: string): this {
		this.value += str;
		return this;
	}
}

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2
}

export class TreeItem {
	public label?: string;
	public description?: string;
	public tooltip?: string | MarkdownString;
	public contextValue?: string;
	public iconPath?: ThemeIcon | Uri;
	public command?: { command: string; title: string; arguments?: unknown[] };

	constructor(
		label: string,
		public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
	) {
		this.label = label;
	}
}

export class RelativePattern {
	constructor(
		public readonly base: Uri | string,
		public readonly pattern: string
	) {}
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2
}

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1,
	Two = 2
}

export enum QuickPickItemKind {
	Separator = -1,
	Default = 0
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3
}

export enum OverviewRulerLane {
	Left = 1,
	Center = 2,
	Right = 4,
	Full = 7
}

export enum ProgressLocation {
	SourceControl = 1,
	Window = 10,
	Notification = 15
}

// Configurable Mock Store
export const mockConfigStore = new Map<string, unknown>();

export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
	registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
		registeredCommands.set(id, handler);
		return { dispose: () => registeredCommands.delete(id) };
	}),
	executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
		const fn = registeredCommands.get(id);
		if (fn) {
			return fn(...args);
		}
		return undefined;
	})
};

export const env = {
	clipboard: {
		writeText: vi.fn(async (_text: string) => undefined),
		readText: vi.fn(async () => '')
	}
};

export const window = {
	activeTextEditor: undefined as {
		document: {
			uri: Uri;
			getText: () => string;
			lineCount: number;
			save: () => Promise<boolean>;
		};
		selection: Selection;
		setDecorations: (...args: unknown[]) => void;
	} | undefined,
	onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
	onDidChangeTextEditorSelection: new EventEmitter<unknown>().event,
	createOutputChannel: vi.fn(() => ({
		appendLine: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn()
	})),
	createStatusBarItem: vi.fn(() => ({
		text: '',
		tooltip: '',
		command: '',
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn()
	})),
	createTextEditorDecorationType: vi.fn(() => ({
		dispose: vi.fn()
	})),
	showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showInputBox: vi.fn(async (_options?: unknown) => undefined as string | undefined),
	showQuickPick: vi.fn(async (_items: unknown, _options?: unknown) => undefined as unknown),
	showOpenDialog: vi.fn(async (_options?: unknown) => undefined as Uri[] | undefined),
	showTextDocument: vi.fn(async (_docOrUri: unknown, _options?: unknown) => ({})),
	withProgress: vi.fn(async (_options: unknown, task: (progress: { report: () => void }) => Promise<unknown>) => {
		return task({ report: vi.fn() });
	}),
	createWebviewPanel: vi.fn((_viewType: string, _title: string, _column: unknown, _options?: unknown) => {
		const msgEmitter = new EventEmitter<unknown>();
		return {
			webview: {
				cspSource: 'vscode-webview:',
				html: '',
				options: {},
				postMessage: vi.fn(async () => true),
				onDidReceiveMessage: msgEmitter.event,
				_fireMessage: (msg: unknown) => msgEmitter.fire(msg)
			},
			dispose: vi.fn()
		};
	}),
	registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
	registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() }))
};

export const workspace = {
	workspaceFolders: [
		{
			uri: Uri.file('/workspace/repo'),
			name: 'repo',
			index: 0
		}
	] as { uri: Uri; name: string; index: number }[] | undefined,
	onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
	onDidChangeConfiguration: new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>().event,
	getConfiguration: vi.fn((section?: string) => ({
		get: vi.fn(<T>(key: string, defaultValue?: T): T => {
			const fullKey = section ? `${section}.${key}` : key;
			if (mockConfigStore.has(fullKey)) {
				return mockConfigStore.get(fullKey) as T;
			}
			return defaultValue as T;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			const fullKey = section ? `${section}.${key}` : key;
			mockConfigStore.set(fullKey, value);
		})
	})),
	createFileSystemWatcher: vi.fn(() => ({
		onDidChange: vi.fn(),
		onDidCreate: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn()
	})),
	openTextDocument: vi.fn(async (arg: unknown) => {
		if (arg && typeof arg === 'object' && 'content' in (arg as Record<string, unknown>)) {
			const content = String((arg as { content?: string }).content ?? '');
			return {
				uri: Uri.file('/tmp/inmemory.txt'),
				getText: () => content,
				lineCount: content.split('\n').length,
				save: vi.fn(async () => true)
			};
		}
		const uri = arg instanceof Uri ? arg : Uri.file(String(arg));
		return {
			uri,
			getText: () => 'line1\nline2\nTODO: fix this\n',
			lineCount: 3,
			save: vi.fn(async () => true)
		};
	}),
	registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() }))
};

export const languages = {
	getDiagnostics: vi.fn((_uri?: Uri) => [] as { severity: DiagnosticSeverity; message: string; range: Range }[])
};

export const scm = {
	createSourceControl: vi.fn((id: string, label: string, rootUri?: Uri) => ({
		id,
		label,
		rootUri,
		inputBox: { value: '', placeholder: '' },
		count: 0,
		quickDiffProvider: undefined,
		acceptInputCommand: undefined,
		statusBarCommands: [],
		createResourceGroup: vi.fn((groupId: string, groupLabel: string) => ({
			id: groupId,
			label: groupLabel,
			hideWhenEmpty: false,
			resourceStates: [],
			dispose: vi.fn()
		})),
		dispose: vi.fn()
	}))
};
