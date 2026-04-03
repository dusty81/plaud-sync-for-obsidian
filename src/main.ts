import {Notice, Plugin, requestUrl, setIcon, TFile} from 'obsidian';
import {registerPlaudCommands} from './commands';
import {type PlaudPluginSettings, normalizeSettings, toPersistedSettings} from './settings-schema';
import {PlaudSettingTab} from './settings';
import {createPlaudSyncRuntime, type PlaudSyncRuntime, type SyncTrigger} from './sync-runtime';
import {createObsidianPlaudApiClient} from './plaud-api-obsidian';
import {getPlaudToken} from './secret-store';
import {normalizePlaudDetail} from './plaud-normalizer';
import {renderPlaudMarkdown} from './plaud-renderer';
import {isTrashedFile, runPlaudSync, type PlaudSyncSummary} from './plaud-sync';
import {type PlaudVaultAdapter, upsertPlaudNote} from './plaud-vault';
import {PlaudApiError, type PlaudApiClient, type PlaudFileDetail} from './plaud-api';
import {DEFAULT_RETRY_POLICY, sanitizeTelemetryMessage, type RetryTelemetryEvent, withRetry} from './plaud-retry';
import {hydratePlaudDetailContent} from './plaud-content-hydrator';
import {buildSignedUrlMap, resolveImages} from './plaud-image-resolver';

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Unknown error';
}

function toActionableMessage(error: unknown): string {
	if (error instanceof PlaudApiError) {
		if (error.category === 'auth') {
			return 'authentication failed. Re-save your Plaud token in settings.';
		}
		if (error.category === 'rate_limit') {
			return 'rate limited by Plaud API. Wait briefly and retry.';
		}
		if (error.category === 'network') {
			return 'network error. Check your connection and retry.';
		}
		if (error.category === 'server') {
			return 'Plaud API is temporarily unavailable. Retry shortly.';
		}
		if (error.category === 'invalid_response') {
			return 'unexpected API response format. Retry and inspect logs if it persists.';
		}
	}

	return sanitizeTelemetryMessage(toErrorMessage(error));
}

function formatSyncSummary(summary: PlaudSyncSummary): string {
	return `Plaud sync complete. Created ${summary.created}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed}.`;
}

export default class PlaudSyncPlugin extends Plugin {
	settings: PlaudPluginSettings;
	private syncRuntime: PlaudSyncRuntime | null = null;
	private statusBarEl: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private isSyncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.syncRuntime = createPlaudSyncRuntime({
			isStartupEnabled: () => this.settings.syncOnStartup,
			runSync: async (trigger) => this.runSync(trigger),
			onLocked: (message) => {
				new Notice(message);
			}
		});

		registerPlaudCommands(this);
		this.addSettingTab(new PlaudSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar('Plaud: idle');

		this.ribbonIconEl = this.addRibbonIcon('refresh-cw', 'Plaud sync', () => {
			void this.runPlaudSyncNow();
		});

		void this.syncRuntime.runStartupSync();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(toPersistedSettings(this.settings));
	}

	async runPlaudSyncNow(): Promise<void> {
		await this.ensureSyncRuntime().runManualSync();
	}

	async validatePlaudToken(): Promise<void> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			new Notice('Plaud token missing. Configure it in settings before validation.');
			return;
		}

		try {
			const api = createObsidianPlaudApiClient({
				apiDomain: this.settings.apiDomain,
				token
			});

			const files = await this.retryApiCall('validate_token.list_files', async () => api.listFiles());
			const activeCount = files.filter((file) => !isTrashedFile(file)).length;
			new Notice(`Plaud token is valid. Active recordings visible: ${activeCount}.`);
		} catch (error) {
			this.logFailure('validate_token_failed', error);
			new Notice(`Plaud token validation failed: ${toActionableMessage(error)}`);
		}
	}

	private updateStatusBar(text: string): void {
		if (this.statusBarEl) {
			this.statusBarEl.setText(text);
		}
	}

	private setSyncingState(syncing: boolean): void {
		this.isSyncing = syncing;
		if (this.ribbonIconEl) {
			if (syncing) {
				this.ribbonIconEl.addClass('plaud-sync-spinning');
			} else {
				this.ribbonIconEl.removeClass('plaud-sync-spinning');
			}
		}
	}

	private ensureSyncRuntime(): PlaudSyncRuntime {
		if (!this.syncRuntime) {
			this.syncRuntime = createPlaudSyncRuntime({
				isStartupEnabled: () => this.settings.syncOnStartup,
				runSync: async (trigger) => this.runSync(trigger),
				onLocked: (message) => {
					new Notice(message);
				}
			});
		}

		return this.syncRuntime;
	}

	private async runSync(trigger: SyncTrigger): Promise<void> {
		this.setSyncingState(true);
		this.updateStatusBar('Plaud: syncing...');
		try {
			const summary = await this.executeSyncBatch();
			this.updateStatusBar(`Plaud: ${summary.created} new, ${summary.updated} updated at ${new Date().toLocaleTimeString()}`);
			if (trigger === 'manual') {
				new Notice(formatSyncSummary(summary));
			}
		} catch (error) {
			this.updateStatusBar('Plaud: sync failed');
			this.logFailure('sync_failed', error);
			new Notice(`Plaud sync failed: ${toActionableMessage(error)}`);
		} finally {
			this.setSyncingState(false);
		}
	}

	private async executeSyncBatch(): Promise<PlaudSyncSummary> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			throw new Error('Plaud token missing. Configure it in settings before syncing.');
		}

		const api = createObsidianPlaudApiClient({
			apiDomain: this.settings.apiDomain,
			token
		});
		const resilientApi: PlaudApiClient = {
			listFiles: async () => this.retryApiCall('sync.list_files', async () => api.listFiles()),
			getFileDetail: async (fileId: string) => {
				const detail = await this.retryApiCall(`sync.file_detail.${fileId}`, async () => api.getFileDetail(fileId));
				const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
					return this.retryApiCall(`sync.content_fetch.${fileId}`, async () => this.fetchSignedContent(url));
				});

				if (typeof hydrated.id === 'string' && hydrated.id.trim().length > 0) {
					return hydrated as PlaudFileDetail;
				}

				return detail;
			}
		};

		return runPlaudSync({
			api: resilientApi,
			vault: this.createVaultAdapter(),
			settings: {
				syncFolder: this.settings.syncFolder,
				filenamePattern: this.settings.filenamePattern,
				expandTitleDate: this.settings.expandTitleDate,
				updateExisting: this.settings.updateExisting,
				lastSyncAtMs: this.settings.lastSyncAtMs
			},
			saveCheckpoint: async (nextLastSyncAtMs) => {
				this.settings.lastSyncAtMs = nextLastSyncAtMs;
				await this.saveSettings();
			},
			normalizeDetail: normalizePlaudDetail,
			renderMarkdown: renderPlaudMarkdown,
			upsertNote: upsertPlaudNote,
			fetchBinary: async (url) => this.fetchSignedBinary(url),
			buildSignedUrlMap,
			resolveImages,
			onProgress: (progress) => {
				this.updateStatusBar(`Plaud: syncing ${progress.current}/${progress.total}...`);
			}
		});
	}

	private async retryApiCall<T>(operation: string, execute: () => Promise<T>): Promise<T> {
		return withRetry(operation, execute, {
			policy: DEFAULT_RETRY_POLICY,
			onRetry: (event) => {
				this.logRetry(event);
			}
		});
	}

	private logRetry(event: RetryTelemetryEvent): void {
		console.warn('[plaud-sync] retry', {
			operation: event.operation,
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			category: event.category ?? 'unknown',
			status: typeof event.status === 'number' ? event.status : null,
			message: event.message
		});
	}

	private logFailure(event: string, error: unknown): void {
		console.warn('[plaud-sync] failure', {
			event,
			category: error instanceof PlaudApiError ? error.category : 'unknown',
			status: error instanceof PlaudApiError && typeof error.status === 'number' ? error.status : null,
			message: sanitizeTelemetryMessage(toErrorMessage(error))
		});
	}

	private async fetchSignedBinary(url: string): Promise<ArrayBuffer> {
		const response = await requestUrl({
			url,
			method: 'GET',
			throw: false
		});

		if (response.status >= 400) {
			throw new Error(`Signed binary fetch failed with HTTP ${response.status}.`);
		}

		return response.arrayBuffer;
	}

	private async fetchSignedContent(url: string): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'GET',
			throw: false
		});

		if (response.status >= 400) {
			throw new Error(`Signed content fetch failed with HTTP ${response.status}.`);
		}

		const text = typeof response.text === 'string' ? response.text.trim() : '';
		if (!text) {
			return '';
		}

		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private createVaultAdapter(): PlaudVaultAdapter {
		return {
			ensureFolder: async (folder) => {
				const normalized = folder.replace(/\/+$/, '').trim();
				if (!normalized) {
					return;
				}

				if (this.app.vault.getAbstractFileByPath(normalized)) {
					return;
				}

				try {
					await this.app.vault.createFolder(normalized);
				} catch {
					if (!this.app.vault.getAbstractFileByPath(normalized)) {
						throw new Error(`Unable to create Plaud sync folder: ${normalized}`);
					}
				}
			},
			listMarkdownFiles: (folder) => {
				const normalized = folder.replace(/\/+$/, '');
				const prefix = `${normalized}/`;
				return Promise.resolve(
					this.app.vault
						.getMarkdownFiles()
						.map((file) => file.path)
						.filter((filePath) => filePath.startsWith(prefix))
				);
			},
			read: async (path) => {
				return this.app.vault.cachedRead(this.requireFile(path));
			},
			write: async (path, content) => {
				await this.app.vault.modify(this.requireFile(path), content);
			},
			create: async (path, content) => {
				await this.app.vault.create(path, content);
			},
			createBinary: async (path, data) => {
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					await this.app.vault.modifyBinary(existing, data);
				} else {
					await this.app.vault.createBinary(path, data);
				}
			}
		};
	}

	private requireFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`Markdown file not found in vault: ${path}`);
		}

		return file;
	}
}
