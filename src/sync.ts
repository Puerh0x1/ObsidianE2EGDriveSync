import { TFile, Vault, Notice } from 'obsidian';
import { CryptoService } from './crypto';
import { GoogleDriveClient } from './gdrive';
import { PluginSettings, FileSyncRecord, DriveFile, SyncAction } from './types';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class SyncEngine {
  private vault: Vault;
  private crypto: CryptoService;
  private drive: GoogleDriveClient;
  private settings: PluginSettings;
  private saveSettings: () => Promise<void>;
  private syncing = false;

  constructor(
    vault: Vault,
    crypto: CryptoService,
    drive: GoogleDriveClient,
    settings: PluginSettings,
    saveSettings: () => Promise<void>
  ) {
    this.vault = vault;
    this.crypto = crypto;
    this.drive = drive;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  async performSync(): Promise<{
    uploaded: number;
    downloaded: number;
    deleted: number;
    conflicts: number;
  }> {
    if (this.syncing) throw new Error('Sync already in progress');
    if (!this.crypto.isUnlocked()) throw new Error('Master key is locked');
    if (!this.drive.isConfigured()) throw new Error('Google Drive not configured');

    this.syncing = true;
    const stats = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };

    try {
      // Ensure root folder
      if (!this.settings.driveFolderId) {
        this.settings.driveFolderId = await this.drive.findOrCreateFolder(
          this.settings.driveFolderName
        );
        await this.saveSettings();
      }

      new Notice('Sync: scanning files...');

      const localFiles = this.getLocalFiles();
      const remoteFiles = await this.buildRemoteFileMap(
        this.settings.driveFolderId, ''
      );

      const actions = await this.computeActions(localFiles, remoteFiles);

      if (actions.length === 0) {
        new Notice('Sync: everything is up to date');
        return stats;
      }

      const total = actions.length;
      let current = 0;

      for (const action of actions) {
        current++;
        try {
          switch (action.type) {
            case 'upload':
              new Notice(`Upload (${current}/${total}): ${action.localPath}`);
              await this.uploadFile(action.localPath);
              stats.uploaded++;
              break;

            case 'download':
              new Notice(`Download (${current}/${total}): ${action.localPath}`);
              await this.downloadFile(action.localPath, action.remoteFile!);
              stats.downloaded++;
              break;

            case 'deleteRemote':
              await this.deleteRemoteFile(action.localPath, action.record!);
              stats.deleted++;
              break;

            case 'deleteLocal':
              delete this.settings.syncState[action.localPath];
              stats.deleted++;
              break;

            case 'conflict':
              new Notice(`Conflict: ${action.localPath}`);
              await this.handleConflict(action.localPath, action.remoteFile!);
              stats.conflicts++;
              break;
          }
        } catch (e: unknown) {
          console.error(`Sync error for ${action.localPath}:`, e);
          const message = e instanceof Error ? e.message : String(e);
          new Notice(`Error: ${action.localPath} — ${message}`);
        }
      }

      await this.saveSettings();
      return stats;
    } finally {
      this.syncing = false;
    }
  }

  // --- Local file scanning ---

  private getLocalFiles(): Map<string, TFile> {
    const files = new Map<string, TFile>();
    for (const file of this.vault.getFiles()) {
      if (!this.shouldExclude(file.path)) {
        files.set(file.path, file);
      }
    }
    return files;
  }

  private shouldExclude(path: string): boolean {
    const alwaysExclude = [`${this.vault.configDir}/`, '.trash/', '.git/'];
    for (const prefix of alwaysExclude) {
      if (path.startsWith(prefix)) return true;
    }

    for (const pattern of this.settings.excludePatterns) {
      if (!pattern) continue;
      if (pattern.startsWith('*.')) {
        if (path.endsWith(pattern.slice(1))) return true;
      } else if (pattern.endsWith('/')) {
        if (path.startsWith(pattern)) return true;
      } else {
        if (path.includes(pattern)) return true;
      }
    }

    return false;
  }

  // --- Remote file scanning ---

  private async buildRemoteFileMap(
    folderId: string,
    basePath: string
  ): Promise<Map<string, DriveFile>> {
    const result = new Map<string, DriveFile>();
    const children = await this.drive.listFiles(folderId);

    for (const child of children) {
      const childPath = basePath ? `${basePath}/${child.name}` : child.name;

      if (child.mimeType === FOLDER_MIME) {
        this.settings.folderCache[childPath] = child.id;
        const subFiles = await this.buildRemoteFileMap(child.id, childPath);
        for (const [path, file] of subFiles) {
          result.set(path, file);
        }
      } else if (child.name.endsWith('.enc')) {
        const fileName = child.name.slice(0, -4);
        const filePath = basePath ? `${basePath}/${fileName}` : fileName;
        result.set(filePath, child);
      }
    }

    return result;
  }

  // --- Action computation ---

  private async computeActions(
    localFiles: Map<string, TFile>,
    remoteFiles: Map<string, DriveFile>
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    const processed = new Set<string>();

    // Check each local file
    for (const [path, file] of localFiles) {
      processed.add(path);
      const record = this.settings.syncState[path];
      const remote = remoteFiles.get(path);

      if (!record) {
        if (remote) {
          // Both exist but never synced — compare timestamps
          const remoteMtime = remote.modifiedTime
            ? new Date(remote.modifiedTime).getTime()
            : 0;
          if (file.stat.mtime > remoteMtime) {
            actions.push({ type: 'upload', localPath: path });
          } else {
            actions.push({ type: 'download', localPath: path, remoteFile: remote });
          }
        } else {
          actions.push({ type: 'upload', localPath: path });
        }
        continue;
      }

      // Was synced before
      const localChanged = file.stat.mtime !== record.localMtime;
      const remoteChanged = remote ? remote.md5Checksum !== record.remoteChecksum : false;

      if (localChanged && remote && !remoteChanged) {
        // Verify actual content change
        const content = await this.vault.readBinary(file);
        const hash = await this.crypto.hashContent(content);
        if (hash !== record.contentHash) {
          actions.push({ type: 'upload', localPath: path });
        } else {
          // Touch only — update mtime record
          record.localMtime = file.stat.mtime;
        }
      } else if (!localChanged && remoteChanged && remote) {
        actions.push({ type: 'download', localPath: path, remoteFile: remote });
      } else if (localChanged && remoteChanged && remote) {
        // Possible conflict — verify local content actually changed
        const content = await this.vault.readBinary(file);
        const hash = await this.crypto.hashContent(content);
        if (hash !== record.contentHash) {
          actions.push({ type: 'conflict', localPath: path, remoteFile: remote });
        } else {
          actions.push({ type: 'download', localPath: path, remoteFile: remote });
        }
      } else if (!remote && record) {
        // Deleted remotely
        actions.push({ type: 'deleteLocal', localPath: path, record });
      }
    }

    // Check remote files not found locally
    for (const [path, remote] of remoteFiles) {
      if (processed.has(path)) continue;

      const record = this.settings.syncState[path];
      if (record) {
        // Was synced but local file deleted
        actions.push({ type: 'deleteRemote', localPath: path, record });
      } else {
        // New remote file
        actions.push({ type: 'download', localPath: path, remoteFile: remote });
      }
    }

    return actions;
  }

  // --- File operations ---

  private async uploadFile(localPath: string): Promise<void> {
    const file = this.vault.getFileByPath(localPath);
    if (!file) return;

    const content = await this.vault.readBinary(file);
    const encrypted = await this.crypto.encrypt(content);
    const contentHash = await this.crypto.hashContent(content);

    const folderId = await this.ensureRemoteFolders(localPath);
    const existing = this.settings.syncState[localPath];

    const driveFile = await this.drive.uploadFile(
      file.name + '.enc',
      encrypted,
      folderId,
      existing?.driveFileId
    );

    this.settings.syncState[localPath] = {
      driveFileId: driveFile.id,
      localMtime: file.stat.mtime,
      contentHash,
      remoteChecksum: driveFile.md5Checksum || '',
      lastSynced: Date.now(),
    };
  }

  private async downloadFile(localPath: string, remote: DriveFile): Promise<void> {
    const encrypted = await this.drive.downloadFile(remote.id);
    const content = await this.crypto.decrypt(encrypted);
    const contentHash = await this.crypto.hashContent(content);

    // Ensure local parent folders
    const lastSlash = localPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await this.ensureLocalFolders(localPath.substring(0, lastSlash));
    }

    const existing = this.vault.getFileByPath(localPath);
    if (existing) {
      await this.vault.modifyBinary(existing, content);
    } else {
      await this.vault.createBinary(localPath, content);
    }

    const file = this.vault.getFileByPath(localPath);
    const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();

    this.settings.syncState[localPath] = {
      driveFileId: remote.id,
      localMtime,
      contentHash,
      remoteChecksum: remote.md5Checksum || '',
      lastSynced: Date.now(),
    };
  }

  private async deleteRemoteFile(
    localPath: string,
    record: FileSyncRecord
  ): Promise<void> {
    try {
      await this.drive.deleteFile(record.driveFileId);
    } catch (e) {
      console.warn(`Could not delete remote ${localPath}:`, e);
    }
    delete this.settings.syncState[localPath];
  }

  private async handleConflict(
    localPath: string,
    remote: DriveFile
  ): Promise<void> {
    // Download remote version as a conflict copy
    const encrypted = await this.drive.downloadFile(remote.id);
    const content = await this.crypto.decrypt(encrypted);

    const dotIndex = localPath.lastIndexOf('.');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const conflictPath =
      dotIndex > 0
        ? `${localPath.slice(0, dotIndex)} (conflict ${ts})${localPath.slice(dotIndex)}`
        : `${localPath} (conflict ${ts})`;

    const lastSlash = conflictPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await this.ensureLocalFolders(conflictPath.substring(0, lastSlash));
    }
    await this.vault.createBinary(conflictPath, content);

    // Upload current local version as the canonical version
    await this.uploadFile(localPath);

    new Notice(`Conflict resolved: created ${conflictPath}`);
  }

  // --- Folder helpers ---

  private async ensureRemoteFolders(filePath: string): Promise<string> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename

    if (parts.length === 0) return this.settings.driveFolderId;

    let parentId = this.settings.driveFolderId;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (this.settings.folderCache[currentPath]) {
        parentId = this.settings.folderCache[currentPath];
        continue;
      }

      parentId = await this.drive.findOrCreateFolder(part, parentId);
      this.settings.folderCache[currentPath] = parentId;
    }

    return parentId;
  }

  private async ensureLocalFolders(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.vault.getFolderByPath(currentPath)) {
        await this.vault.createFolder(currentPath);
      }
    }
  }
}
