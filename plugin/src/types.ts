export type ConflictResolution = 'last-write-wins' | 'obsidian-wins' | 'outline-wins';
export type InitialSyncDirection = 'obsidian-to-outline' | 'outline-to-obsidian' | 'bidirectional';

export interface SyncState {
  lastSyncTime: number;
  fileHashes: Record<string, string>;
  outlineIdMap: Record<string, string>;   // outlineId → obsidianPath
  pathToOutlineId: Record<string, string>; // obsidianPath → outlineId
  firstSyncDone: boolean;
}

export interface ObslineSettings {
  outlineUrl: string;
  outlineApiToken: string;
  syncInterval: number; // 0 = on-change, N = every N minutes
  conflictResolution: ConflictResolution;
  initialSyncDirection: InitialSyncDirection;
  inboxCollection: string; // collection name for root-level notes
  ignorePaths: string[];
  syncState: SyncState;
}

export const DEFAULT_SETTINGS: ObslineSettings = {
  outlineUrl: '',
  outlineApiToken: '',
  syncInterval: 5,
  conflictResolution: 'last-write-wins',
  initialSyncDirection: 'bidirectional',
  inboxCollection: 'Inbox',
  ignorePaths: ['.obsidian', '.trash', '.DS_Store', 'Templates'],
  syncState: {
    lastSyncTime: 0,
    fileHashes: {},
    outlineIdMap: {},
    pathToOutlineId: {},
    firstSyncDone: false,
  },
};

export interface OutlineCollection {
  id: string;
  name: string;
  description: string | null;
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

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  renamed: number;
  conflicts: string[];
  errors: string[];
}
