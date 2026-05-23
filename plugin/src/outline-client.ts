import { requestUrl } from 'obsidian';
import { OutlineAttachmentCreate, OutlineCollection, OutlineDocument } from './types';

export class OutlineClient {
  private apiBase: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.apiBase = baseUrl.replace(/\/$/, '') + '/api';
    this.token = token;
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    // throw:false — Obsidian's requestUrl throws on network errors by default,
    // but we want to handle 4xx/5xx ourselves rather than get an opaque exception.
    const response = await requestUrl({
      url: `${this.apiBase}${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Outline API error ${response.status} at ${endpoint}`);
    }

    return response.json as T;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.post('/documents.list', {});
      return true;
    } catch {
      return false;
    }
  }

  async listCollections(): Promise<OutlineCollection[]> {
    const res = await this.post<{ data: OutlineCollection[] }>('/collections.list', {});
    return res.data;
  }

  async createCollection(name: string, description?: string): Promise<OutlineCollection> {
    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    const res = await this.post<{ data: OutlineCollection }>('/collections.create', body);
    return res.data;
  }

  async updateCollection(id: string, name: string): Promise<OutlineCollection> {
    const res = await this.post<{ data: OutlineCollection }>('/collections.update', { id, name });
    return res.data;
  }

  async listDocuments(): Promise<OutlineDocument[]> {
    type DocEntry = {
      id: string; title: string; updatedAt: string; createdAt: string;
      collectionId: string; parentDocumentId: string | null; published: boolean;
    };
    const all: OutlineDocument[] = [];
    const limit = 100;
    let offset = 0;

    while (true) {
      const res = await this.post<{ data: DocEntry[]; pagination: { total: number } }>(
        '/documents.list', { limit, offset },
      );
      all.push(...res.data.map(doc => ({
        ...doc, text: '', published: doc.published ?? false,
      })));
      offset += res.data.length;
      if (res.data.length < limit) break;
    }

    return all;
  }

  async getDocument(id: string): Promise<OutlineDocument> {
    const res = await this.post<{ data: OutlineDocument }>('/documents.info', { id });
    return { ...res.data, published: res.data.published ?? false };
  }

  async createDocument(
    title: string,
    text: string,
    collectionId?: string,
    parentDocumentId?: string,
  ): Promise<OutlineDocument> {
    // publish:true required — omitting it creates a Draft invisible to other users.
    const body: Record<string, unknown> = { title, text, publish: true };
    if (collectionId) body.collectionId = collectionId;
    if (parentDocumentId) body.parentDocumentId = parentDocumentId;
    const res = await this.post<{ data: OutlineDocument }>('/documents.create', body);
    return { ...res.data, published: true };
  }

  async updateDocument(id: string, text: string, title?: string): Promise<OutlineDocument> {
    const body: Record<string, unknown> = { id, text, publish: true };
    if (title) body.title = title;
    const res = await this.post<{ data: OutlineDocument }>('/documents.update', body);
    return { ...res.data, published: true };
  }

  async deleteCollection(id: string): Promise<void> {
    await this.post('/collections.delete', { id });
  }

  async moveDocument(id: string, collectionId: string, parentDocumentId?: string): Promise<OutlineDocument | undefined> {
    const body: Record<string, unknown> = { id, collectionId };
    if (parentDocumentId) body.parentDocumentId = parentDocumentId;
    // documents.move returns { data: { documents: [...affected docs...] } }
    const res = await this.post<{ data: { documents?: Array<Partial<OutlineDocument> & { id: string }> } }>(
      '/documents.move', body,
    );
    const moved = res.data?.documents?.find(d => d.id === id);
    return moved ? { ...(moved as OutlineDocument), published: moved.published ?? true } : undefined;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.post('/documents.delete', { id });
  }

  /**
   * Download an attachment's binary content. `attachments.redirect` 302s to the real
   * file; Electron's net (under requestUrl) follows the redirect automatically. S3
   * presigned URLs authenticate via query signature, so a stray Authorization header
   * is ignored; for local storage the hop stays same-host where the header is needed.
   */
  async downloadAttachment(id: string): Promise<{ data: ArrayBuffer; contentType?: string }> {
    const response = await requestUrl({
      url: `${this.apiBase}/attachments.redirect?id=${encodeURIComponent(id)}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.token}` },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Outline attachment download error ${response.status} for ${id}`);
    }
    return {
      data: response.arrayBuffer,
      contentType: response.headers?.['content-type'],
    };
  }

  /** Step 1 of upload: reserve an attachment + get the presigned upload target. */
  async createAttachment(
    name: string, contentType: string, size: number, documentId?: string,
  ): Promise<OutlineAttachmentCreate> {
    const body: Record<string, unknown> = { name, contentType, size };
    if (documentId) body.documentId = documentId;
    const res = await this.post<{ data: OutlineAttachmentCreate }>('/attachments.create', body);
    return res.data;
  }

  /**
   * Step 2 of upload: multipart POST the file to the presigned `uploadUrl`. iOS/Android
   * have no reliable FormData/Blob, so the multipart body is assembled by hand as an
   * ArrayBuffer. Form fields precede the `file` field. No Outline auth on presigned S3.
   */
  async uploadAttachment(
    uploadUrl: string, form: Record<string, string>, data: ArrayBuffer, contentType: string, fileName: string,
  ): Promise<void> {
    const boundary = '----ObslineBoundary' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [k, v] of Object.entries(form)) {
      chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    ));
    chunks.push(new Uint8Array(data));
    chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.byteLength; }

    const isAbsolute = /^https?:\/\//i.test(uploadUrl);
    const url = isAbsolute ? uploadUrl : `${this.apiBase.replace(/\/api$/, '')}${uploadUrl}`;
    const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    if (!isAbsolute) headers['Authorization'] = `Bearer ${this.token}`; // same-host local storage

    const res = await requestUrl({ url, method: 'POST', headers, body: body.buffer, throw: false });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Outline attachment upload error ${res.status} for "${fileName}"`);
    }
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.post('/attachments.delete', { id });
  }
}
