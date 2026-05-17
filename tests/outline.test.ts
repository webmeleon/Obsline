import { OutlineClient, OutlineDocument } from '../src/core/outline';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OutlineClient', () => {
  const baseUrl = 'https://outline.example.com';
  const token = 'test-token-123';
  let client: OutlineClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new OutlineClient(baseUrl, token);
  });

  describe('constructor', () => {
    test('should initialize with correct base URL and token', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: `${baseUrl}/api`,
          headers: expect.objectContaining({
            'Authorization': `Bearer ${token}`,
          }),
        })
      );
    });

    test('should remove trailing slash from baseUrl', () => {
      const clientWithSlash = new OutlineClient(`${baseUrl}/`, token);
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: `${baseUrl}/api`,
        })
      );
    });
  });

  describe('testConnection', () => {
    test('should return true on successful connection', async () => {
      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({}),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.testConnection();
      expect(result).toBe(true);
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.list', {});
    });

    test('should return false on failed connection', async () => {
      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockRejectedValue(new Error('Connection failed')),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('listDocuments', () => {
    test('should return list of documents', async () => {
      const mockDocuments = [
        { id: '1', title: 'Doc 1', updatedAt: '2026-05-17T00:00:00Z', createdAt: '2026-05-16T00:00:00Z' },
        { id: '2', title: 'Doc 2', updatedAt: '2026-05-17T01:00:00Z', createdAt: '2026-05-16T01:00:00Z' },
      ];

      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({
          data: { data: mockDocuments },
        }),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.listDocuments();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
      expect(result[0].title).toBe('Doc 1');
    });

    test('should throw on error', async () => {
      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockRejectedValue(new Error('API error')),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      await expect(testClient.listDocuments()).rejects.toThrow('API error');
    });
  });

  describe('getDocument', () => {
    test('should retrieve a document by ID', async () => {
      const mockDoc = {
        id: '1',
        title: 'Test Doc',
        text: 'Test content',
        updatedAt: '2026-05-17T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      };

      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({
          data: { data: mockDoc },
        }),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.getDocument('1');
      expect(result.id).toBe('1');
      expect(result.title).toBe('Test Doc');
      expect(result.text).toBe('Test content');
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.info', { id: '1' });
    });
  });

  describe('createDocument', () => {
    test('should create a document', async () => {
      const newDoc = {
        id: '3',
        title: 'New Doc',
        text: 'New content',
        updatedAt: '2026-05-17T12:00:00Z',
        createdAt: '2026-05-17T12:00:00Z',
      };

      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({
          data: { data: newDoc },
        }),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.createDocument('New Doc', 'New content');
      expect(result.id).toBe('3');
      expect(result.title).toBe('New Doc');
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.create', {
        title: 'New Doc',
        text: 'New content',
      });
    });

    test('should create a document with collectionId', async () => {
      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({
          data: { data: { id: '3', title: 'New Doc', text: 'content', updatedAt: '', createdAt: '' } },
        }),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      await testClient.createDocument('New Doc', 'content', 'col-123');
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.create', {
        title: 'New Doc',
        text: 'content',
        collectionId: 'col-123',
      });
    });
  });

  describe('updateDocument', () => {
    test('should update a document', async () => {
      const updated = {
        id: '1',
        title: 'Updated Doc',
        text: 'Updated content',
        updatedAt: '2026-05-17T13:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      };

      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({
          data: { data: updated },
        }),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      const result = await testClient.updateDocument('1', 'Updated content');
      expect(result.text).toBe('Updated content');
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.update', {
        id: '1',
        text: 'Updated content',
      });
    });
  });

  describe('deleteDocument', () => {
    test('should delete a document', async () => {
      const mockInstance = {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({}),
      };
      mockedAxios.create.mockReturnValue(mockInstance as any);
      const testClient = new OutlineClient(baseUrl, token);

      await testClient.deleteDocument('1');
      expect(mockInstance.post).toHaveBeenCalledWith('/documents.delete', { id: '1' });
    });
  });
});
