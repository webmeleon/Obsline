var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ObslinePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/types.ts
var DEFAULT_SETTINGS = {
  outlineUrl: "",
  outlineApiToken: "",
  syncInterval: 5,
  conflictResolution: "last-write-wins",
  initialSyncDirection: "bidirectional",
  ignorePaths: [".obsidian", ".trash", ".DS_Store", "Templates"],
  syncState: {
    lastSyncTime: 0,
    fileHashes: {},
    outlineIdMap: {},
    pathToOutlineId: {},
    firstSyncDone: false
  }
};

// src/sync-engine.ts
var import_obsidian2 = require("obsidian");
var import_crypto = require("crypto");

// src/outline-client.ts
var import_obsidian = require("obsidian");
var OutlineClient = class {
  constructor(baseUrl, token) {
    this.apiBase = baseUrl.replace(/\/$/, "") + "/api";
    this.token = token;
  }
  async post(endpoint, body) {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.apiBase}${endpoint}`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Outline API error ${response.status} at ${endpoint}`);
    }
    return response.json;
  }
  async testConnection() {
    try {
      await this.post("/documents.list", {});
      return true;
    } catch (e) {
      return false;
    }
  }
  async listCollections() {
    const res = await this.post("/collections.list", {});
    return res.data;
  }
  async createCollection(name, description) {
    const body = { name };
    if (description)
      body.description = description;
    const res = await this.post("/collections.create", body);
    return res.data;
  }
  async listDocuments() {
    const res = await this.post("/documents.list", {});
    return res.data.map((doc) => {
      var _a;
      return {
        ...doc,
        text: "",
        published: (_a = doc.published) != null ? _a : false
      };
    });
  }
  async getDocument(id) {
    var _a;
    const res = await this.post("/documents.info", { id });
    return { ...res.data, published: (_a = res.data.published) != null ? _a : false };
  }
  async createDocument(title, text, collectionId, parentDocumentId) {
    const body = { title, text, publish: true };
    if (collectionId)
      body.collectionId = collectionId;
    if (parentDocumentId)
      body.parentDocumentId = parentDocumentId;
    const res = await this.post("/documents.create", body);
    return { ...res.data, published: true };
  }
  async updateDocument(id, text, title) {
    const body = { id, text, publish: true };
    if (title)
      body.title = title;
    const res = await this.post("/documents.update", body);
    return { ...res.data, published: true };
  }
  async deleteDocument(id) {
    await this.post("/documents.delete", { id });
  }
};

// src/sync-engine.ts
var SyncEngine = class {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    this.client = new OutlineClient(settings.outlineUrl, settings.outlineApiToken);
  }
  updateSettings(settings) {
    this.settings = settings;
    this.client = new OutlineClient(settings.outlineUrl, settings.outlineApiToken);
  }
  async testConnection() {
    return this.client.testConnection();
  }
  async sync(onProgress) {
    const result = { created: 0, updated: 0, deleted: 0, renamed: 0, conflicts: [], errors: [] };
    const state = this.settings.syncState;
    onProgress == null ? void 0 : onProgress("Reading vault\u2026");
    const vaultNotes = await this.readVault();
    onProgress == null ? void 0 : onProgress("Fetching Outline data\u2026");
    const [collections, outlineDocsList] = await Promise.all([
      this.client.listCollections(),
      this.client.listDocuments()
    ]);
    onProgress == null ? void 0 : onProgress("Loading document content\u2026");
    const fullDocs = [];
    const docById = /* @__PURE__ */ new Map();
    const hashToOutlineId = /* @__PURE__ */ new Map();
    for (const doc of outlineDocsList) {
      try {
        const full = await this.client.getDocument(doc.id);
        fullDocs.push(full);
        docById.set(full.id, full);
        if (full.text)
          hashToOutlineId.set(this.hash(full.text), full.id);
      } catch (e) {
        result.errors.push(`Failed to load doc ${doc.id}: ${String(e)}`);
      }
    }
    const updatedCollections = await this.ensureCollections(vaultNotes, collections, onProgress);
    const collectionNameById = new Map(updatedCollections.map((c) => [c.id, c.name]));
    const collectionIdByName = new Map(updatedCollections.map((c) => [c.name, c.id]));
    const outlineDocByKey = /* @__PURE__ */ new Map();
    for (const doc of fullDocs) {
      outlineDocByKey.set(`${doc.collectionId}::${doc.title}`, doc);
    }
    const obsidianMap = new Map(vaultNotes.map((n) => [n.path, n]));
    const pathToOutlineIds = /* @__PURE__ */ new Map();
    for (const [oid, opath] of Object.entries(state.outlineIdMap)) {
      if (!pathToOutlineIds.has(opath))
        pathToOutlineIds.set(opath, []);
      pathToOutlineIds.get(opath).push(oid);
    }
    const firstSync = !state.firstSyncDone;
    const dir = this.settings.initialSyncDirection;
    if (!firstSync || dir === "obsidian-to-outline" || dir === "bidirectional") {
      for (const note of vaultNotes) {
        const knownId = state.pathToOutlineId[note.path];
        const outlineDoc = knownId ? docById.get(knownId) : void 0;
        if (!outlineDoc) {
          const noteHash = this.hash(note.content);
          const renamedFromId = hashToOutlineId.get(noteHash);
          const renamedFromPath = renamedFromId ? state.outlineIdMap[renamedFromId] : void 0;
          if (renamedFromId && renamedFromPath && renamedFromPath !== note.path) {
            onProgress == null ? void 0 : onProgress(`Rename: "${renamedFromPath}" \u2192 "${note.path}"`);
            try {
              await this.client.updateDocument(renamedFromId, note.content, note.title);
              state.outlineIdMap[renamedFromId] = note.path;
              state.pathToOutlineId[note.path] = renamedFromId;
              delete state.pathToOutlineId[renamedFromPath];
              result.renamed++;
            } catch (e) {
              result.errors.push(`Rename failed: ${String(e)}`);
            }
          } else {
            const { collectionId, parentDocumentId } = this.collectionFromPath(note.path, collectionIdByName);
            const adoptKey = collectionId ? `${collectionId}::${note.title}` : `::${note.title}`;
            const existing = outlineDocByKey.get(adoptKey);
            if (existing && !state.outlineIdMap[existing.id]) {
              onProgress == null ? void 0 : onProgress(`Adopting existing Outline doc: ${note.path}`);
              state.outlineIdMap[existing.id] = note.path;
              state.pathToOutlineId[note.path] = existing.id;
            } else {
              onProgress == null ? void 0 : onProgress(`Creating in Outline: ${note.path}`);
              try {
                const created = await this.client.createDocument(note.title, note.content, collectionId, parentDocumentId);
                state.outlineIdMap[created.id] = note.path;
                state.pathToOutlineId[note.path] = created.id;
                result.created++;
              } catch (e) {
                result.errors.push(`Create failed for ${note.path}: ${String(e)}`);
              }
            }
          }
        } else {
          const noteHash = this.hash(note.content);
          const docHash = this.hash(outlineDoc.text);
          const titleChanged = note.title !== outlineDoc.title;
          if (noteHash !== docHash || titleChanged) {
            const winner = this.resolveConflict(note, outlineDoc);
            onProgress == null ? void 0 : onProgress(`Updating: ${note.path}`);
            try {
              if (winner === "obsidian") {
                await this.client.updateDocument(outlineDoc.id, note.content, note.title);
              } else {
                await this.writeNote(note.path, outlineDoc.text);
              }
              result.updated++;
            } catch (e) {
              result.errors.push(`Update failed for ${note.path}: ${String(e)}`);
            }
          }
        }
        state.fileHashes[note.path] = this.hash(note.content);
      }
    }
    if (!firstSync || dir === "outline-to-obsidian" || dir === "bidirectional") {
      for (const doc of fullDocs) {
        const mappedPath = state.outlineIdMap[doc.id];
        if (mappedPath && obsidianMap.has(mappedPath))
          continue;
        const notePath = this.buildPath(doc, collectionNameById, docById);
        const existingIds = pathToOutlineIds.get(notePath) || [];
        if (existingIds.length > 0) {
          state.outlineIdMap[doc.id] = notePath;
          state.pathToOutlineId[notePath] = doc.id;
        } else if (!this.noteExists(notePath)) {
          onProgress == null ? void 0 : onProgress(`Pulling from Outline: ${notePath}`);
          try {
            await this.writeNote(notePath, doc.text);
            state.outlineIdMap[doc.id] = notePath;
            state.pathToOutlineId[notePath] = doc.id;
            pathToOutlineIds.set(notePath, [doc.id]);
            result.created++;
          } catch (e) {
            result.errors.push(`Write failed for ${notePath}: ${String(e)}`);
          }
        } else {
          state.outlineIdMap[doc.id] = notePath;
          state.pathToOutlineId[notePath] = doc.id;
          pathToOutlineIds.set(notePath, [doc.id]);
        }
      }
    }
    state.lastSyncTime = Date.now();
    state.firstSyncDone = true;
    return result;
  }
  async ensureCollections(notes, collections, onProgress) {
    const existingNames = new Set(collections.map((c) => c.name));
    const folders = /* @__PURE__ */ new Set();
    for (const note of notes) {
      const parts = note.path.split("/");
      if (parts.length > 1)
        folders.add(parts[0]);
    }
    const updated = [...collections];
    for (const folder of folders) {
      if (!existingNames.has(folder)) {
        onProgress == null ? void 0 : onProgress(`Creating Outline collection: ${folder}`);
        try {
          const col = await this.client.createCollection(folder);
          updated.push(col);
          existingNames.add(folder);
        } catch (e) {
        }
      }
    }
    return updated;
  }
  async readVault() {
    const files = this.app.vault.getMarkdownFiles();
    const notes = [];
    for (const file of files) {
      if (this.isIgnored(file.path))
        continue;
      const content = await this.app.vault.read(file);
      notes.push({
        file,
        path: file.path,
        title: file.basename,
        content,
        lastModified: file.stat.mtime
      });
    }
    return notes;
  }
  isIgnored(filePath) {
    return this.settings.ignorePaths.some(
      (ignore) => filePath === ignore || filePath.startsWith(ignore + "/")
    );
  }
  noteExists(notePath) {
    return this.app.vault.getAbstractFileByPath(notePath) instanceof import_obsidian2.TFile;
  }
  async writeNote(notePath, content) {
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof import_obsidian2.TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.ensureFolder(notePath);
      await this.app.vault.create(notePath, content);
    }
  }
  async ensureFolder(notePath) {
    const parts = notePath.split("/");
    parts.pop();
    if (parts.length === 0)
      return;
    const folderPath = parts.join("/");
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    }
  }
  buildPath(doc, collectionNameById, docById) {
    var _a;
    const parts = [];
    let parentId = doc.parentDocumentId;
    while (parentId) {
      const parent = docById.get(parentId);
      if (!parent)
        break;
      parts.unshift(parent.title);
      parentId = parent.parentDocumentId;
    }
    const collectionName = (_a = collectionNameById.get(doc.collectionId)) != null ? _a : "Unsorted";
    parts.unshift(collectionName);
    parts.push(`${doc.title}.md`);
    return parts.join("/");
  }
  collectionFromPath(notePath, collectionIdByName) {
    const parts = notePath.split("/").filter(Boolean);
    if (parts.length < 2)
      return {};
    const collectionId = collectionIdByName.get(parts[0]);
    return { collectionId };
  }
  resolveConflict(note, doc) {
    if (this.settings.conflictResolution === "obsidian-wins")
      return "obsidian";
    if (this.settings.conflictResolution === "outline-wins")
      return "outline";
    const outlineTime = new Date(doc.updatedAt).getTime();
    return note.lastModified > outlineTime ? "obsidian" : "outline";
  }
  hash(content) {
    return (0, import_crypto.createHash)("md5").update(content).digest("hex");
  }
};

// src/settings.ts
var import_obsidian3 = require("obsidian");
var ObslineSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsline \u2013 Outline Sync" });
    containerEl.createEl("h3", { text: "Outline Connection" });
    new import_obsidian3.Setting(containerEl).setName("Outline server URL").setDesc("The base URL of your Outline instance (e.g. https://notes.example.com)").addText(
      (text) => text.setPlaceholder("https://notes.example.com").setValue(this.plugin.settings.outlineUrl).onChange(async (value) => {
        this.plugin.settings.outlineUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("API key").setDesc(
      createFragment((f) => {
        f.appendText("Your Outline API key. ");
        f.createEl("strong", { text: "How to create one: " });
        f.appendText('In Outline \u2192 Settings \u2192 API Tokens \u2192 Create a token. Give it a descriptive name like "Obsidian Sync".');
      })
    ).addText(
      (text) => text.setPlaceholder("ol_api_...").setValue(this.plugin.settings.outlineApiToken).onChange(async (value) => {
        this.plugin.settings.outlineApiToken = value.trim();
        await this.plugin.saveSettings();
      }).then((t) => t.inputEl.type = "password")
    );
    new import_obsidian3.Setting(containerEl).setName("Test connection").setDesc("Verify that your server URL and API key are correct.").addButton(
      (btn) => btn.setButtonText("Test").setCta().onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing\u2026");
        const ok = await this.plugin.syncEngine.testConnection();
        btn.setDisabled(false).setButtonText("Test");
        if (ok) {
          new import_obsidian3.Notice("\u2713 Connected to Outline successfully!");
        } else {
          new import_obsidian3.Notice("\u2717 Connection failed \u2014 check URL and API key.", 5e3);
        }
      })
    );
    containerEl.createEl("h3", { text: "Sync behaviour" });
    new import_obsidian3.Setting(containerEl).setName("Sync trigger").setDesc("When to automatically sync.").addDropdown(
      (drop) => drop.addOption("0", "On change (debounced 30 s)").addOption("1", "Every 1 minute").addOption("2", "Every 2 minutes").addOption("5", "Every 5 minutes").addOption("10", "Every 10 minutes").addOption("15", "Every 15 minutes").addOption("30", "Every 30 minutes").setValue(String(this.plugin.settings.syncInterval)).onChange(async (value) => {
        this.plugin.settings.syncInterval = Number(value);
        await this.plugin.saveSettings();
        this.plugin.setupSync();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Conflict resolution").setDesc("What to do when both sides changed the same note.").addDropdown(
      (drop) => drop.addOption("last-write-wins", "Last write wins").addOption("obsidian-wins", "Obsidian always wins").addOption("outline-wins", "Outline always wins").setValue(this.plugin.settings.conflictResolution).onChange(async (value) => {
        this.plugin.settings.conflictResolution = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Ignored paths").setDesc("Comma-separated list of folders or files to exclude (e.g. Templates, Attachments).").addTextArea(
      (text) => text.setValue(this.plugin.settings.ignorePaths.join(", ")).onChange(async (value) => {
        this.plugin.settings.ignorePaths = value.split(",").map((s) => s.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Initial sync" });
    const firstDone = this.plugin.settings.syncState.firstSyncDone;
    new import_obsidian3.Setting(containerEl).setName("First-sync direction").setDesc(
      firstDone ? "First sync already completed \u2014 always bidirectional from now on." : "Choose which side is authoritative for the very first sync. After that, sync is always bidirectional."
    ).addDropdown((drop) => {
      drop.addOption("bidirectional", "Bidirectional (merge both sides)").addOption("obsidian-to-outline", "Obsidian \u2192 Outline (push local notes)").addOption("outline-to-obsidian", "Outline \u2192 Obsidian (pull remote notes)").setValue(this.plugin.settings.initialSyncDirection).setDisabled(firstDone).onChange(async (value) => {
        this.plugin.settings.initialSyncDirection = value;
        await this.plugin.saveSettings();
      });
    });
    if (firstDone) {
      new import_obsidian3.Setting(containerEl).setName("Reset sync state").setDesc("Clears all sync mappings and resets the first-sync flag. Use with caution \u2014 the next sync will re-evaluate all documents.").addButton(
        (btn) => btn.setButtonText("Reset").setWarning().onClick(async () => {
          this.plugin.settings.syncState = {
            lastSyncTime: 0,
            fileHashes: {},
            outlineIdMap: {},
            pathToOutlineId: {},
            firstSyncDone: false
          };
          await this.plugin.saveSettings();
          new import_obsidian3.Notice("Sync state reset. Choose a first-sync direction and sync again.");
          this.display();
        })
      );
    }
    containerEl.createEl("h3", { text: "Status" });
    const lastSync = this.plugin.settings.syncState.lastSyncTime;
    const trackedCount = Object.keys(this.plugin.settings.syncState.outlineIdMap).length;
    new import_obsidian3.Setting(containerEl).setName("Last sync").setDesc(lastSync > 0 ? new Date(lastSync).toLocaleString() : "Never");
    new import_obsidian3.Setting(containerEl).setName("Tracked documents").setDesc(String(trackedCount));
    new import_obsidian3.Setting(containerEl).setName("Sync now").setDesc("Trigger an immediate sync.").addButton(
      (btn) => btn.setButtonText("Sync now").setCta().onClick(() => this.plugin.runSync())
    );
  }
};

// src/main.ts
var DEBOUNCE_MS = 3e4;
var ObslinePlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.changeTimer = null;
    this.isSyncing = false;
  }
  async onload() {
    await this.loadSettings();
    this.syncEngine = new SyncEngine(this.app, this.settings);
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus("Idle");
    this.addRibbonIcon("refresh-cw", "Obsline: Sync now", () => this.runSync());
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.runSync()
    });
    this.addCommand({
      id: "open-settings",
      name: "Open Obsline settings",
      callback: () => this.app.setting.open("obsline")
    });
    this.addSettingTab(new ObslineSettingTab(this.app, this));
    this.setupSync();
    console.log("Obsline plugin loaded");
  }
  onunload() {
    if (this.changeTimer)
      clearTimeout(this.changeTimer);
    console.log("Obsline plugin unloaded");
  }
  setupSync() {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.settings.syncInterval === 0) {
      this.registerEvent(
        this.app.vault.on("create", (file) => this.scheduleSync(file))
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => this.scheduleSync(file))
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => this.scheduleSync(file))
      );
      this.registerEvent(
        this.app.vault.on("rename", (file) => this.scheduleSync(file))
      );
    } else {
      const ms = this.settings.syncInterval * 60 * 1e3;
      this.registerInterval(window.setInterval(() => this.runSync(), ms));
    }
  }
  scheduleSync(file) {
    if (!(file instanceof import_obsidian4.TFile) || !file.path.endsWith(".md"))
      return;
    if (this.settings.ignorePaths.some(
      (p) => file.path === p || file.path.startsWith(p + "/")
    ))
      return;
    if (this.changeTimer)
      clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.runSync(), DEBOUNCE_MS);
    this.updateStatus("Change detected\u2026");
  }
  async runSync() {
    if (this.isSyncing)
      return;
    if (!this.settings.outlineUrl || !this.settings.outlineApiToken) {
      new import_obsidian4.Notice("Obsline: Configure Outline URL and API key in settings first.");
      return;
    }
    this.isSyncing = true;
    this.updateStatus("Syncing\u2026");
    this.syncEngine.updateSettings(this.settings);
    try {
      const result = await this.syncEngine.sync((msg2) => this.updateStatus(msg2));
      const summary = [
        result.created > 0 && `+${result.created}`,
        result.updated > 0 && `~${result.updated}`,
        result.deleted > 0 && `-${result.deleted}`,
        result.renamed > 0 && `\u21AA${result.renamed}`
      ].filter(Boolean).join(" ") || "nothing new";
      this.settings.syncState = { ...this.settings.syncState };
      await this.saveSettings();
      const msg = `Sync done: ${summary}`;
      this.updateStatus(`Last sync ${new Date().toLocaleTimeString()}`);
      new import_obsidian4.Notice(`Obsline: ${msg}`);
      if (result.errors.length > 0) {
        new import_obsidian4.Notice(`Obsline: ${result.errors.length} error(s) \u2014 check console`, 8e3);
        result.errors.forEach((e) => console.error("[Obsline]", e));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateStatus("Sync error");
      new import_obsidian4.Notice(`Obsline sync failed: ${msg}`, 8e3);
      console.error("[Obsline] Sync error:", err);
    } finally {
      this.isSyncing = false;
    }
  }
  updateStatus(text) {
    this.statusBarItem.setText(`Obsline: ${text}`);
  }
  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved, {
      syncState: Object.assign({}, DEFAULT_SETTINGS.syncState, saved == null ? void 0 : saved.syncState)
    });
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
