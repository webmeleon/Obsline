import { Plugin, Notice, TFile, TAbstractFile, requestUrl } from 'obsidian';
import { ObslineSettings, DEFAULT_SETTINGS } from './types';
import { SyncEngine } from './sync-engine';
import { ObslineSettingTab } from './settings';
import JSZip from 'jszip';

const GITHUB_REPO = 'webmeleon/Obsline';

const DEBOUNCE_MS = 30_000; // 30 s after last change

export default class ObslinePlugin extends Plugin {
  settings: ObslineSettings;
  syncEngine: SyncEngine;

  private statusBarItem: HTMLElement;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;

  async onload() {
    await this.loadSettings();

    this.syncEngine = new SyncEngine(this.app, this.settings);

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus('Idle');

    // Ribbon icon
    this.addRibbonIcon('refresh-cw', 'Obsline: Sync now', () => this.runSync());

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: 'open-settings',
      name: 'Open Obsline settings',
      callback: () => (this.app as any).setting.open('obsline'),
    });

    // Settings tab
    this.addSettingTab(new ObslineSettingTab(this.app, this));

    // Start sync scheduler
    this.setupSync();

    // Check for updates after startup
    setTimeout(() => this.checkForUpdates(), 5000);

    console.log('Obsline plugin loaded');
  }

  onunload() {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    console.log('Obsline plugin unloaded');
  }

  setupSync() {
    // Clear any on-change listeners we registered before
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }

    if (this.settings.syncInterval === 0) {
      // On-change mode: watch vault events
      this.registerEvent(
        this.app.vault.on('create', (file) => this.scheduleSync(file)),
      );
      this.registerEvent(
        this.app.vault.on('modify', (file) => this.scheduleSync(file)),
      );
      this.registerEvent(
        this.app.vault.on('delete', (file) => this.scheduleSync(file)),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file) => this.scheduleSync(file)),
      );
    } else {
      // Interval mode
      const ms = this.settings.syncInterval * 60 * 1000;
      this.registerInterval(window.setInterval(() => this.runSync(), ms));
    }
  }

  private scheduleSync(file: TAbstractFile) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    if (this.settings.ignorePaths.some(
      p => file.path === p || file.path.startsWith(p + '/')
    )) return;

    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.runSync(), DEBOUNCE_MS);
    this.updateStatus('Change detected…');
  }

  async runSync() {
    if (this.isSyncing) return;
    if (!this.settings.outlineUrl || !this.settings.outlineApiToken) {
      new Notice('Obsline: Configure Outline URL and API key in settings first.');
      return;
    }

    this.isSyncing = true;
    this.updateStatus('Syncing…');
    this.syncEngine.updateSettings(this.settings);

    try {
      const result = await this.syncEngine.sync((msg) => this.updateStatus(msg));

      const summary = [
        result.created > 0 && `+${result.created}`,
        result.updated > 0 && `~${result.updated}`,
        result.deleted > 0 && `-${result.deleted}`,
        result.renamed > 0 && `↪${result.renamed}`,
      ]
        .filter(Boolean)
        .join(' ') || 'nothing new';

      this.settings.syncState = { ...this.settings.syncState };
      await this.saveSettings();

      const msg = `Sync done: ${summary}`;
      this.updateStatus(`Last sync ${new Date().toLocaleTimeString()}`);
      new Notice(`Obsline: ${msg}`);

      if (result.errors.length > 0) {
        new Notice(`Obsline: ${result.errors.length} error(s) — check console`, 8000);
        result.errors.forEach(e => console.error('[Obsline]', e));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateStatus('Sync error');
      new Notice(`Obsline sync failed: ${msg}`, 8000);
      console.error('[Obsline] Sync error:', err);
    } finally {
      this.isSyncing = false;
    }
  }

  private updateStatus(text: string) {
    this.statusBarItem.setText(`Obsline: ${text}`);
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved, {
      syncState: Object.assign({}, DEFAULT_SETTINGS.syncState, saved?.syncState),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async checkForUpdates() {
    try {
      const response = await requestUrl({
        url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        headers: { 'User-Agent': 'Obsline-Plugin' },
      });

      const release = response.json;
      const latestVersion = (release.tag_name as string).replace('v', '');

      if (!this.isNewerVersion(latestVersion, this.manifest.version)) return;

      const frag = document.createDocumentFragment();
      frag.appendText(`Obsline v${latestVersion} verfügbar. `);
      const btn = frag.createEl('button', { text: 'Jetzt updaten' });
      const notice = new Notice(frag, 0);

      btn.onclick = async () => {
        notice.hide();
        await this.installUpdate(latestVersion, release);
      };
    } catch (e) {
      console.log('[Obsline] Update-Check fehlgeschlagen:', e);
    }
  }

  private async installUpdate(version: string, release: any) {
    const progress = new Notice('Obsline: Update wird heruntergeladen…', 0);
    try {
      const zipAsset = release.assets?.find((a: any) => a.name.endsWith('.zip'));
      const zipUrl = zipAsset?.browser_download_url
        ?? `https://github.com/${GITHUB_REPO}/releases/download/v${version}/obsline-v${version}.zip`;

      const zipResponse = await requestUrl({ url: zipUrl });
      const zip = await JSZip.loadAsync(zipResponse.arrayBuffer);

      const pluginDir = `${this.app.vault.configDir}/plugins/obsline`;

      for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
        const file = zip.file(filename);
        if (file) {
          const content = await file.async('string');
          await this.app.vault.adapter.write(`${pluginDir}/${filename}`, content);
        }
      }

      progress.hide();
      new Notice('Obsline aktualisiert! Obsidian neu starten um die Änderungen zu übernehmen.', 0);
    } catch (e) {
      progress.hide();
      new Notice(`Obsline Update fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`, 8000);
      console.error('[Obsline] Update fehlgeschlagen:', e);
    }
  }

  private isNewerVersion(latest: string, current: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const [la, lb, lc] = parse(latest);
    const [ca, cb, cc] = parse(current);
    return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
  }
}
