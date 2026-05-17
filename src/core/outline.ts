import axios, { AxiosInstance } from 'axios';
import { Logger } from '../utils/logger';

const logger = new Logger('OutlineClient');

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  updatedAt: string;
  createdAt?: string;
}

interface OutlineListResponse {
  data: Array<{ id: string; title: string; updatedAt: string; createdAt: string }>;
}

interface OutlineDocResponse {
  data: { id: string; title: string; text: string; updatedAt: string; createdAt: string };
}

export class OutlineClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;

    this.client = axios.create({
      baseURL: `${this.baseUrl}/api`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    logger.debug(`OutlineClient initialized for ${this.baseUrl}`);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/documents.list');
      logger.info('Connection to Outline successful');
      return true;
    } catch (error) {
      logger.error(
        `Connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  async listDocuments(): Promise<OutlineDocument[]> {
    try {
      const response = await this.client.get<OutlineListResponse>('/documents.list');
      logger.debug(`Listed ${response.data.data.length} documents`);
      return response.data.data.map(doc => ({
        id: doc.id,
        title: doc.title,
        text: '',
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
      }));
    } catch (error) {
      logger.error(`Failed to list documents: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getDocument(id: string): Promise<OutlineDocument> {
    try {
      const response = await this.client.get<OutlineDocResponse>('/documents.info', {
        params: { id },
      });
      logger.debug(`Retrieved document: ${response.data.data.title}`);
      return response.data.data;
    } catch (error) {
      logger.error(
        `Failed to get document ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async createDocument(
    title: string,
    text: string,
    collectionId?: string
  ): Promise<OutlineDocument> {
    try {
      const payload: Record<string, unknown> = {
        title,
        text,
      };
      if (collectionId) {
        payload.collectionId = collectionId;
      }

      const response = await this.client.post<OutlineDocResponse>('/documents.create', payload);
      logger.info(`Created document: ${response.data.data.title}`);
      return response.data.data;
    } catch (error) {
      logger.error(
        `Failed to create document: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async updateDocument(id: string, text: string): Promise<OutlineDocument> {
    try {
      const response = await this.client.post<OutlineDocResponse>('/documents.update', {
        id,
        text,
      });
      logger.info(`Updated document: ${response.data.data.title}`);
      return response.data.data;
    } catch (error) {
      logger.error(
        `Failed to update document ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async deleteDocument(id: string): Promise<void> {
    try {
      await this.client.post('/documents.delete', { id });
      logger.info(`Deleted document: ${id}`);
    } catch (error) {
      logger.error(
        `Failed to delete document ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
}
