export type ConflictResolution = 'last-write-wins' | 'obsidian-wins' | 'outline-wins';
export type InitialSyncDirection = 'obsidian-to-outline' | 'outline-to-obsidian' | 'bidirectional';

export interface AttachmentState {
  idToPath: Record<string, string>;  // outline attachmentId → vault-relative attachment path
  pathToId: Record<string, string>;  // vault-relative attachment path → outline attachmentId
  binHashes: Record<string, string>; // vault-relative attachment path → hash(binary content)
}

export interface SyncState {
  lastSyncTime: number;
  fileHashes: Record<string, string>;
  outlineIdMap: Record<string, string>;   // outlineId → obsidianPath
  pathToOutlineId: Record<string, string>; // obsidianPath → outlineId
  outlineUpdatedAt: Record<string, string>; // outlineId → last-synced updatedAt (ISO); drives change detection
  attachments: AttachmentState;            // attachment id ↔ path ↔ binary-hash mapping (idempotent embeds)
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
  attachmentFolder: string; // vault-relative folder for attachments pulled from Outline
  syncAttachments: boolean; // master toggle for attachment/image sync
  cleanupOrphanAttachments: boolean; // delete Outline attachments no synced doc references (opt-in)
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
  attachmentFolder: 'attachments',
  syncAttachments: true,
  cleanupOrphanAttachments: false,
  syncState: {
    lastSyncTime: 0,
    fileHashes: {},
    outlineIdMap: {},
    pathToOutlineId: {},
    outlineUpdatedAt: {},
    attachments: { idToPath: {}, pathToId: {}, binHashes: {} },
    firstSyncDone: false,
  },
};

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

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  renamed: number;
  conflicts: string[];
  errors: string[];
}
