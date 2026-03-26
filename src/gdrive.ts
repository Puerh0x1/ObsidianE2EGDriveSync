import { requestUrl } from 'obsidian';
import { DriveFile, PluginSettings } from './types';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class GoogleDriveClient {
  private settings: PluginSettings;
  private onTokenUpdate: (updates: Partial<PluginSettings>) => Promise<void>;

  constructor(
    settings: PluginSettings,
    onTokenUpdate: (updates: Partial<PluginSettings>) => Promise<void>
  ) {
    this.settings = settings;
    this.onTokenUpdate = onTokenUpdate;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    return !!(this.settings.googleClientId && this.settings.googleRefreshToken);
  }

  // --- OAuth 2.0 with loopback redirect ---

  async authorize(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http') as typeof import('http');

    return new Promise((resolve, reject) => {
      let resolved = false;

      const server = http.createServer(async (req: any, res: any) => {
        if (resolved) return;
        try {
          const url = new URL(req.url!, 'http://127.0.0.1');
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.authPage(`Error: ${error}`, false));
            resolved = true;
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing code parameter');
            return;
          }

          const port = (server.address() as any).port;
          const tokens = await this.exchangeCode(code, `http://127.0.0.1:${port}`);

          await this.onTokenUpdate({
            googleAccessToken: tokens.access_token,
            googleRefreshToken: tokens.refresh_token || this.settings.googleRefreshToken,
            googleTokenExpiry: Date.now() + tokens.expires_in * 1000,
          });

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.authPage('Authorization successful! You can close this tab.', true));
          resolved = true;
          server.close();
          resolve();
        } catch (e: any) {
          if (!resolved) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.authPage(`Error: ${e.message}`, false));
            resolved = true;
            server.close();
            reject(e);
          }
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        const params = new URLSearchParams({
          client_id: this.settings.googleClientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
        });
        window.open(`${GOOGLE_AUTH_URL}?${params}`);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          server.close();
          reject(new Error('OAuth timeout — no response within 5 minutes'));
        }
      }, 300000);
    });
  }

  private authPage(message: string, success: boolean): string {
    const color = success ? '#4caf50' : '#f44336';
    const icon = success ? '&#10004;' : '&#10008;';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
      align-items:center;min-height:100vh;margin:0;background:#1e1e1e;color:#fff}
      .card{text-align:center;padding:3em;border-radius:12px;background:#2d2d2d}
      .icon{font-size:3em;color:${color}}</style></head>
      <body><div class="card"><div class="icon">${icon}</div>
      <h1>${message}</h1><p>Return to Obsidian.</p></div></body></html>`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<any> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.settings.googleClientId,
        client_secret: this.settings.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    return response.json;
  }

  // --- Token management ---

  async ensureToken(): Promise<void> {
    if (!this.settings.googleRefreshToken) {
      throw new Error('Not authorized with Google Drive');
    }
    if (Date.now() < this.settings.googleTokenExpiry - 60000) {
      return;
    }
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.settings.googleClientId,
        client_secret: this.settings.googleClientSecret,
        refresh_token: this.settings.googleRefreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    const data = response.json;
    await this.onTokenUpdate({
      googleAccessToken: data.access_token,
      googleTokenExpiry: Date.now() + data.expires_in * 1000,
    });
  }

  private get authHeaders(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.settings.googleAccessToken}` };
  }

  // --- File operations ---

  async findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    await this.ensureToken();

    let q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    if (parentId) q += ` and '${parentId}' in parents`;

    const search = await requestUrl({
      url: `${DRIVE_API}/files?${new URLSearchParams({
        q, fields: 'files(id)', pageSize: '1',
      })}`,
      headers: this.authHeaders,
    });

    if (search.json.files?.length > 0) {
      return search.json.files[0].id;
    }

    const metadata: Record<string, any> = { name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];

    const create = await requestUrl({
      url: `${DRIVE_API}/files`,
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });

    return create.json.id;
  }

  async listFiles(folderId: string): Promise<DriveFile[]> {
    await this.ensureToken();

    const files: DriveFile[] = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await requestUrl({
        url: `${DRIVE_API}/files?${params}`,
        headers: this.authHeaders,
      });

      if (response.json.files) files.push(...response.json.files);
      pageToken = response.json.nextPageToken || '';
    } while (pageToken);

    return files;
  }

  async uploadFile(
    name: string,
    data: ArrayBuffer,
    folderId: string,
    existingFileId?: string
  ): Promise<DriveFile> {
    await this.ensureToken();

    const boundary = '----E2EGDriveSyncBoundary' + Date.now();
    const fields = 'id,name,md5Checksum,modifiedTime';

    if (existingFileId) {
      // Update existing file
      const body = this.buildMultipartBody(boundary, { name }, data);
      const response = await requestUrl({
        url: `${DRIVE_UPLOAD}/files/${existingFileId}?uploadType=multipart&fields=${fields}`,
        method: 'PATCH',
        headers: {
          ...this.authHeaders,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
      });
      return response.json;
    } else {
      // Create new file
      const body = this.buildMultipartBody(boundary, { name, parents: [folderId] }, data);
      const response = await requestUrl({
        url: `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${fields}`,
        method: 'POST',
        headers: {
          ...this.authHeaders,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
      });
      return response.json;
    }
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    await this.ensureToken();

    const response = await requestUrl({
      url: `${DRIVE_API}/files/${fileId}?alt=media`,
      headers: this.authHeaders,
    });

    return response.arrayBuffer;
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.ensureToken();

    await requestUrl({
      url: `${DRIVE_API}/files/${fileId}`,
      method: 'DELETE',
      headers: this.authHeaders,
    });
  }

  // --- Helpers ---

  private buildMultipartBody(
    boundary: string,
    metadata: Record<string, any>,
    fileData: ArrayBuffer
  ): ArrayBuffer {
    const metaJson = JSON.stringify(metadata);
    const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--`;

    const headerBytes = new TextEncoder().encode(header);
    const footerBytes = new TextEncoder().encode(footer);
    const fileBytes = new Uint8Array(fileData);

    const result = new Uint8Array(headerBytes.length + fileBytes.length + footerBytes.length);
    result.set(headerBytes, 0);
    result.set(fileBytes, headerBytes.length);
    result.set(footerBytes, headerBytes.length + fileBytes.length);

    return result.buffer;
  }
}
