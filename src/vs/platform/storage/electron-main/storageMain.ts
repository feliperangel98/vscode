/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { exists, writeFile } from 'vs/base/node/pfs';
import { Event, Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ILogService, LogLevel } from 'vs/platform/log/common/log';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { SQLiteStorageDatabase, ISQLiteStorageDatabaseLoggingOptions } from 'vs/base/parts/storage/node/storage';
import { Storage, InMemoryStorageDatabase, StorageHint, IStorage } from 'vs/base/parts/storage/common/storage';
import { join } from 'vs/base/common/path';
import { IS_NEW_KEY } from 'vs/platform/storage/common/storage';
import { currentSessionDateStorageKey, firstSessionDateStorageKey, instanceStorageKey, lastSessionDateStorageKey } from 'vs/platform/telemetry/common/telemetry';
import { generateUuid } from 'vs/base/common/uuid';
import { IEmptyWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier } from 'vs/platform/workspaces/common/workspaces';
import { ILifecycleMainService, LifecycleMainPhase } from 'vs/platform/lifecycle/electron-main/lifecycleMainService';

/**
 * Provides access to global and workspace storage from the
 * electron-main side that is the owner of all storage connections.
 */
export interface IStorageMain {

	/**
	 * Emitted whenever data is updated or deleted.
	 */
	readonly onDidChangeStorage: Event<IStorageChangeEvent>;

	/**
	 * Emitted when the storage is about to persist. This is the right time
	 * to persist data to ensure it is stored before the application shuts
	 * down.
	 *
	 * Note: this event may be fired many times, not only on shutdown to prevent
	 * loss of state in situations where the shutdown is not sufficient to
	 * persist the data properly.
	 */
	readonly onWillSaveState: Event<void>;

	/**
	 * Emitted when the storage is closed.
	 */
	readonly onDidCloseStorage: Event<void>;

	/**
	 * Access to all cached items of this storage service.
	 */
	readonly items: Map<string, string>;

	/**
	 * Required call to ensure the service can be used.
	 */
	initialize(): Promise<void>;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined.
	 */
	get(key: string, fallbackValue: string): string;
	get(key: string, fallbackValue?: string): string | undefined;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined. The element
	 * will be converted to a boolean.
	 */
	getBoolean(key: string, fallbackValue: boolean): boolean;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined. The element
	 * will be converted to a number using parseInt with a base of 10.
	 */
	getNumber(key: string, fallbackValue: number): number;
	getNumber(key: string, fallbackValue?: number): number | undefined;

	/**
	 * Store a string value under the given key to storage. The value will
	 * be converted to a string.
	 */
	store(key: string, value: string | boolean | number | undefined | null): void;

	/**
	 * Delete an element stored under the provided key from storage.
	 */
	remove(key: string): void;

	/**
	 * Close the storage connection.
	 */
	close(): Promise<void>;
}

export interface IStorageChangeEvent {
	key: string;
}

abstract class BaseStorageMain extends Disposable implements IStorageMain {

	protected readonly _onDidChangeStorage = this._register(new Emitter<IStorageChangeEvent>());
	readonly onDidChangeStorage = this._onDidChangeStorage.event;

	protected readonly _onWillSaveState = this._register(new Emitter<void>());
	readonly onWillSaveState = this._onWillSaveState.event;

	private readonly _onDidCloseStorage = this._register(new Emitter<void>());
	readonly onDidCloseStorage = this._onDidCloseStorage.event;

	private storage: IStorage = new Storage(new InMemoryStorageDatabase()); // storage is in-memory until initialized

	private initializePromise: Promise<void> | undefined = undefined;

	constructor(
		protected readonly logService: ILogService,
		private readonly lifecycleMainService: ILifecycleMainService
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Lifecycle: Warmup (in parallel to window open)
		(async () => {
			await this.lifecycleMainService.when(LifecycleMainPhase.AfterWindowOpen);

			this.initialize();
		})();

		// Lifecycle: Shutdown
		this.lifecycleMainService.onWillShutdown(e => e.join(this.close()));
	}

	initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = (async () => {
				try {
					const storage = await this.doInitialize();

					// Replace our in-memory storage with the initialized
					// one once that is finished and use it from then on
					this.storage.dispose();
					this.storage = storage;

					// Ensure we track wether storage is new or not
					const isNewStorage = storage.getBoolean(IS_NEW_KEY);
					if (isNewStorage === undefined) {
						storage.set(IS_NEW_KEY, true);
					} else if (isNewStorage) {
						storage.set(IS_NEW_KEY, false);
					}
				} catch (error) {
					this.logService.error(`StorageMain#initialize(): Unable to init storage due to ${error}`);
				}
			})();
		}

		return this.initializePromise;
	}

	protected createLogginOptions(): ISQLiteStorageDatabaseLoggingOptions {
		return {
			logTrace: (this.logService.getLevel() === LogLevel.Trace) ? msg => this.logService.trace(msg) : undefined,
			logError: error => this.logService.error(error)
		};
	}

	protected abstract doInitialize(): Promise<IStorage>;

	get items(): Map<string, string> { return this.storage.items; }

	get(key: string, fallbackValue: string): string;
	get(key: string, fallbackValue?: string): string | undefined;
	get(key: string, fallbackValue?: string): string | undefined {
		return this.storage.get(key, fallbackValue);
	}

	getBoolean(key: string, fallbackValue: boolean): boolean;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined {
		return this.storage.getBoolean(key, fallbackValue);
	}

	getNumber(key: string, fallbackValue: number): number;
	getNumber(key: string, fallbackValue?: number): number | undefined;
	getNumber(key: string, fallbackValue?: number): number | undefined {
		return this.storage.getNumber(key, fallbackValue);
	}

	store(key: string, value: string | boolean | number | undefined | null): Promise<void> {
		return this.storage.set(key, value);
	}

	remove(key: string): Promise<void> {
		return this.storage.delete(key);
	}

	async close(): Promise<void> {

		// Propagate to storage lib
		await this.storage.close();

		// Signal as event
		this._onDidCloseStorage.fire();
	}
}

export class GlobalStorageMain extends BaseStorageMain implements IStorageMain {

	private static readonly STORAGE_NAME = 'state.vscdb';

	constructor(
		logService: ILogService,
		private readonly environmentService: IEnvironmentService,
		lifecycleMainService: ILifecycleMainService
	) {
		super(logService, lifecycleMainService);
	}

	protected async doInitialize(): Promise<IStorage> {
		let storagePath: string;
		if (!!this.environmentService.extensionTestsLocationURI) {
			storagePath = SQLiteStorageDatabase.IN_MEMORY_PATH; // no storage during extension tests!
		} else {
			storagePath = join(this.environmentService.globalStorageHome.fsPath, GlobalStorageMain.STORAGE_NAME);
		}

		// Create Storage
		const storage = new Storage(new SQLiteStorageDatabase(storagePath, {
			logging: this.createLogginOptions()
		}));

		// Re-emit storage changes via event
		this._register(storage.onDidChangeStorage(key => this._onDidChangeStorage.fire({ key })));

		// Forward init to SQLite DB
		await storage.init();

		// Apply global telemetry values as part of the initialization
		this.updateTelemetryState(storage);

		return storage;
	}

	private updateTelemetryState(storage: Storage): void {

		// Instance UUID (once)
		const instanceId = storage.get(instanceStorageKey, undefined);
		if (instanceId === undefined) {
			storage.set(instanceStorageKey, generateUuid());
		}

		// First session date (once)
		const firstSessionDate = storage.get(firstSessionDateStorageKey, undefined);
		if (firstSessionDate === undefined) {
			storage.set(firstSessionDateStorageKey, new Date().toUTCString());
		}

		// Last / current session (always)
		// previous session date was the "current" one at that time
		// current session date is "now"
		const lastSessionDate = storage.get(currentSessionDateStorageKey, undefined);
		const currentSessionDate = new Date().toUTCString();
		storage.set(lastSessionDateStorageKey, typeof lastSessionDate === 'undefined' ? null : lastSessionDate);
		storage.set(currentSessionDateStorageKey, currentSessionDate);
	}

	close(): Promise<void> {

		// Signal as event so that clients can still store data
		this._onWillSaveState.fire();

		// Do it
		return super.close();
	}
}

export class WorkspaceStorageMain extends BaseStorageMain implements IStorageMain {

	private static readonly WORKSPACE_STORAGE_NAME = 'state.vscdb';
	private static readonly WORKSPACE_META_NAME = 'workspace.json';

	constructor(
		private workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | IEmptyWorkspaceIdentifier,
		logService: ILogService,
		private readonly environmentService: IEnvironmentService,
		lifecycleMainService: ILifecycleMainService
	) {
		super(logService, lifecycleMainService);
	}

	protected async doInitialize(): Promise<IStorage> {

		// Prepare workspace storage folder for DB
		const { storageFilePath, wasCreated } = await this.prepareWorkspaceStorageFolder();

		// Create Storage
		const storage = new Storage(new SQLiteStorageDatabase(storageFilePath, {
			logging: this.createLogginOptions()
		}), { hint: wasCreated ? StorageHint.STORAGE_DOES_NOT_EXIST : undefined });

		// Re-emit storage changes via event
		this._register(storage.onDidChangeStorage(key => this._onDidChangeStorage.fire({ key })));

		// Forward init to SQLite DB
		await storage.init();

		return storage;
	}

	private async prepareWorkspaceStorageFolder(): Promise<{ storageFilePath: string, wasCreated: boolean }> {

		// Return early with in-memory when running extension tests
		if (!!this.environmentService.extensionTestsLocationURI) {
			return { storageFilePath: SQLiteStorageDatabase.IN_MEMORY_PATH, wasCreated: true };
		}

		// Otherwise, ensure the storage folder exists on disk
		const workspaceStorageFolderPath = join(this.environmentService.workspaceStorageHome.fsPath, this.workspace.id);
		const workspaceStorageDatabasePath = join(workspaceStorageFolderPath, WorkspaceStorageMain.WORKSPACE_STORAGE_NAME);

		const storageExists = await exists(workspaceStorageFolderPath);
		if (storageExists) {
			return { storageFilePath: workspaceStorageDatabasePath, wasCreated: false };
		}

		await promises.mkdir(workspaceStorageFolderPath, { recursive: true });

		// Write metadata into folder
		this.ensureWorkspaceStorageFolderMeta(workspaceStorageFolderPath);

		return { storageFilePath: workspaceStorageDatabasePath, wasCreated: true };
	}

	private ensureWorkspaceStorageFolderMeta(workspaceStorageFolderPath: string): void {
		let meta: object | undefined = undefined;
		if (isSingleFolderWorkspaceIdentifier(this.workspace)) {
			meta = { folder: this.workspace.uri.toString() };
		} else if (isWorkspaceIdentifier(this.workspace)) {
			meta = { workspace: this.workspace.configPath.toString() };
		}

		if (meta) {
			(async () => {
				try {
					const workspaceStorageMetaPath = join(workspaceStorageFolderPath, WorkspaceStorageMain.WORKSPACE_META_NAME);
					const storageExists = await exists(workspaceStorageMetaPath);
					if (!storageExists) {
						await writeFile(workspaceStorageMetaPath, JSON.stringify(meta, undefined, 2));
					}
				} catch (error) {
					this.logService.error(`StorageMain#ensureWorkspaceStorageFolderMeta(): Unable to create workspace storage metadata due to ${error}`);
				}
			})();
		}
	}
}
