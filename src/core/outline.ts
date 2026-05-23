import axios, { AxiosInstance } from 'axios';
import { Logger } from '../utils/logger';

const logger = new Logger('OutlineClient');

export interface OutlineCollection {
  id: string;
  name: string;
  description: string | null;
}

export interface OutlineAttachmentCreate {
  uploadUrl: string;                 // presigned S3 POST (or local) target
  form: Record<string, string>;      // multipart fields to send before the file
  attachment: { id: string; url: string; name?: string; contentType?: string; size?: number };
  maxUploadSize?: number;
}

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  updatedAt: string;
  createdAt?: string;
  collectionId: string;
  parentDocumentId: string | null;
  published: boolean;
}

interface OutlineListResponse {
  data: Array<{
    id: string;
    title: string;
    updatedAt: string;
    createdAt: string;
    collectionId: string;
    parentDocumentId: string | null;
    published: boolean;
  }>;
}

interface OutlineDocResponse {
  data: {
    id: string;
    title: string;
    text: string;
    updatedAt: string;
    createdAt: string;
    collectionId: string;
    parentDocumentId: string | null;
    published: boolean;
  };
}

interface OutlineCollectionsResponse {
  data: Array<{ id: string; name: string; description: string | null }>;
}

export class OutlineClient {
  private client: AxiosInstance;

  constructor(baseUrl: string, token: string) {
    this.client = axios.create({
      baseURL: `${baseUrl.replace(/\/$/, '')}/api`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    logger.debug(`OutlineClient initialized for ${baseUrl}`);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.post('/documents.list', {});
      logger.info('Connection to Outline successful');
      return true;
    } catch (error) {
      logger.error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async listDocuments(): Promise<OutlineDocument[]> {
    const all: OutlineDocument[] = [];
    const limit = 100;
    let offset = 0;

    try {
      while (true) {
        const response = await this.client.post<OutlineListResponse & { pagination: { total: number } }>(
          '/documents.list', { limit, offset }
        );
        const docs = response.data.data.map(doc => ({
          id: doc.id, title: doc.title, text: '',
          updatedAt: doc.updatedAt, createdAt: doc.createdAt,
          collectionId: doc.collectionId, parentDocumentId: doc.parentDocumentId,
          published: doc.published ?? false,
        }));
        all.push(...docs);
        offset += docs.length;
        if (docs.length < limit) break;
      }
      logger.debug(`Listed ${all.length} documents`);
      return all;
    } catch (error) {
      logger.error(`Failed to list documents: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getDocument(id: string): Promise<OutlineDocument> {
    try {
      const response = await this.client.post<OutlineDocResponse>('/documents.info', { id });
      logger.debug(`Retrieved document: ${response.data.data.title}`);
      return { ...response.data.data, published: response.data.data.published ?? false };
    } catch (error) {
      logger.error(`Failed to get document ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async createDocument(
    title: string,
    text: string,
    collectionId?: string,
    parentDocumentId?: string
  ): Promise<OutlineDocument> {
    try {
      // publish:true required — omitting it creates a Draft invisible to other users.
      const payload: Record<string, unknown> = { title, text, publish: true };
      if (collectionId) payload.collectionId = collectionId;
      if (parentDocumentId) payload.parentDocumentId = parentDocumentId;

      const response = await this.client.post<OutlineDocResponse>('/documents.create', payload);
      logger.info(`Created document: ${response.data.data.title}`);
      return { ...response.data.data, published: response.data.data.published ?? true };
    } catch (error) {
      logger.error(`Failed to create document: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async updateDocument(id: string, text: string, title?: string): Promise<OutlineDocument> {
    try {
      const payload: Record<string, unknown> = { id, text, publish: true };
      if (title) payload.title = title;
      const response = await this.client.post<OutlineDocResponse>('/documents.update', payload);
      logger.info(`Updated document: ${response.data.data.title}`);
      return { ...response.data.data, published: response.data.data.published ?? true };
    } catch (error) {
      logger.error(`Failed to update document ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async moveDocument(id: string, collectionId: string, parentDocumentId?: string): Promise<OutlineDocument | undefined> {
    try {
      const payload: Record<string, unknown> = { id, collectionId };
      if (parentDocumentId) payload.parentDocumentId = parentDocumentId;
      // documents.move returns { data: { documents: [...affected docs...] } }
      const response = await this.client.post<{ data: { documents?: Array<Partial<OutlineDocument> & { id: string }> } }>(
        '/documents.move', payload
      );
      logger.info(`Moved document: ${id} → parent=${parentDocumentId ?? 'root'}`);
      const moved = response.data.data?.documents?.find(d => d.id === id);
      return moved ? { ...(moved as OutlineDocument), published: moved.published ?? true } : undefined;
    } catch (error) {
      logger.error(`Failed to move document ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async deleteDocument(id: string): Promise<void> {
    try {
      await this.client.post('/documents.delete', { id });
      logger.info(`Deleted document: ${id}`);
    } catch (error) {
      logger.error(`Failed to delete document ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Download an attachment's binary content. `attachments.redirect` 302s to the real
   * file (presigned S3 URL or local stream); axios follows it and `follow-redirects`
   * drops the Authorization header on a cross-host hop, so it never leaks to S3.
   */
  async downloadAttachment(id: string): Promise<{ data: Buffer; contentType?: string }> {
    try {
      const response = await this.client.get('/attachments.redirect', {
        params: { id },
        responseType: 'arraybuffer',
      });
      logger.debug(`Downloaded attachment ${id} (${(response.data as ArrayBuffer).byteLength} bytes)`);
      const ct = response.headers['content-type'];
      return {
        data: Buffer.from(response.data as ArrayBuffer),
        contentType: typeof ct === 'string' ? ct : undefined,
      };
    } catch (error) {
      logger.error(`Failed to download attachment ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** Step 1 of upload: reserve an attachment + get the presigned upload target. */
  async createAttachment(
    name: string, contentType: string, size: number, documentId?: string,
  ): Promise<OutlineAttachmentCreate> {
    try {
      const payload: Record<string, unknown> = { name, contentType, size };
      if (documentId) payload.documentId = documentId;
      const response = await this.client.post<{ data: OutlineAttachmentCreate }>('/attachments.create', payload);
      logger.debug(`Created attachment record: ${response.data.data.attachment.id}`);
      return response.data.data;
    } catch (error) {
      logger.error(`Failed to create attachment "${name}": ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Step 2 of upload: multipart POST the file to the presigned `uploadUrl`. The form
   * fields from createAttachment MUST come before the `file` field. No Outline auth
   * header here — the presigned URL authenticates itself (S3) or is same-host local.
   */
  async uploadAttachment(
    uploadUrl: string, form: Record<string, string>, data: Buffer, contentType: string, fileName: string,
  ): Promise<void> {
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) fd.append(k, v);
      fd.append('file', new Blob([data], { type: contentType }), fileName);
      // Local-storage Outline returns a same-host uploadUrl; resolve it against baseURL.
      const target = /^https?:\/\//i.test(uploadUrl)
        ? uploadUrl
        : `${this.client.defaults.baseURL!.replace(/\/api$/, '')}${uploadUrl}`;
      const headers = /^https?:\/\//i.test(uploadUrl)
        ? undefined                                          // presigned S3 — no auth
        : { Authorization: this.client.defaults.headers['Authorization'] as string };
      await axios.post(target, fd, { headers, maxBodyLength: Infinity, maxContentLength: Infinity });
      logger.debug(`Uploaded attachment file "${fileName}" (${data.byteLength} bytes)`);
    } catch (error) {
      logger.error(`Failed to upload attachment "${fileName}": ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** Best-effort cleanup of an orphaned attachment (Phase C). */
  async deleteAttachment(id: string): Promise<void> {
    try {
      await this.client.post('/attachments.delete', { id });
      logger.info(`Deleted attachment: ${id}`);
    } catch (error) {
      logger.error(`Failed to delete attachment ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async listCollections(): Promise<OutlineCollection[]> {
    try {
      const response = await this.client.post<OutlineCollectionsResponse>('/collections.list', {});
      logger.debug(`Listed ${response.data.data.length} collections`);
      return response.data.data;
    } catch (error) {
      logger.error(`Failed to list collections: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async createCollection(name: string, description?: string): Promise<OutlineCollection> {
    try {
      const payload: Record<string, unknown> = { name };
      if (description) payload.description = description;
      const response = await this.client.post<{ data: OutlineCollection }>('/collections.create', payload);
      logger.info(`Created collection: ${response.data.data.name}`);
      return response.data.data;
    } catch (error) {
      logger.error(`Failed to create collection: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async updateCollection(id: string, name: string): Promise<OutlineCollection> {
    try {
      const response = await this.client.post<{ data: OutlineCollection }>('/collections.update', { id, name });
      logger.info(`Renamed collection ${id} → ${name}`);
      return response.data.data;
    } catch (error) {
      logger.error(`Failed to update collection ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async deleteCollection(id: string): Promise<void> {
    try {
      await this.client.post('/collections.delete', { id });
      logger.info(`Deleted collection: ${id}`);
    } catch (error) {
      logger.error(`Failed to delete collection ${id}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
