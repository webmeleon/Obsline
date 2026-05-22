import { requestUrl } from 'obsidian';
import { OutlineCollection, OutlineDocument } from './types';

export class OutlineClient {
  private apiBase: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.apiBase = baseUrl.replace(/\/$/, '') + '/api';
    this.token = token;
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
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

  async listDocuments(): Promise<OutlineDocument[]> {
    const res = await this.post<{
      data: Array<{
        id: string;
        title: string;
        updatedAt: string;
        createdAt: string;
        collectionId: string;
        parentDocumentId: string | null;
        published: boolean;
      }>;
    }>('/documents.list', {});

    return res.data.map(doc => ({
      ...doc,
      text: '',
      published: doc.published ?? false,
    }));
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

  async moveDocument(id: string, collectionId: string, parentDocumentId?: string): Promise<void> {
    const body: Record<string, unknown> = { id, collectionId };
    if (parentDocumentId) body.parentDocumentId = parentDocumentId;
    await this.post('/documents.move', body);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.post('/documents.delete', { id });
  }
}
