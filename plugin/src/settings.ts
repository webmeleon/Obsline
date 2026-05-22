import { App, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import type ObslinePlugin from './main';
import { ConflictResolution, InitialSyncDirection } from './types';

export class ObslineSettingTab extends PluginSettingTab {
  plugin: ObslinePlugin;

  constructor(app: App, plugin: ObslinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsline – Outline Sync' });

    // ── Connection ──────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Outline Connection' });

    containerEl.createEl('p', {
      text: 'The sync covers all collections and documents visible to the API token owner — including collections shared via group permissions.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Outline server URL')
      .setDesc('The base URL of your Outline instance (e.g. https://notes.example.com)')
      .addText(text =>
        text
          .setPlaceholder('https://notes.example.com')
          .setValue(this.plugin.settings.outlineUrl)
          .onChange(async value => {
            this.plugin.settings.outlineUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        createFragment(f => {
          f.appendText('Your Outline API key. ');
          f.createEl('strong', { text: 'How to create one: ' });
          f.appendText('In Outline → Settings → API Tokens → Create a token. ' +
            'Give it a descriptive name like "Obsidian Sync".');
        }),
      )
      .addText(text =>
        text
          .setPlaceholder('ol_api_...')
          .setValue(this.plugin.settings.outlineApiToken)
          .onChange(async value => {
            this.plugin.settings.outlineApiToken = value.trim();
            await this.plugin.saveSettings();
          })
          .then(t => (t.inputEl.type = 'password')),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify that your server URL and API key are correct.')
      .addButton(btn =>
        btn
          .setButtonText('Test')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true).setButtonText('Testing…');
            const ok = await this.plugin.syncEngine.testConnection();
            btn.setDisabled(false).setButtonText('Test');
            if (ok) {
              new Notice('✓ Connected to Outline successfully!');
            } else {
              new Notice('✗ Connection failed — check URL and API key.', 5000);
            }
          }),
      );

    // ── Sync behaviour ──────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Sync behaviour' });

    new Setting(containerEl)
      .setName('Sync trigger')
      .setDesc('When to automatically sync.')
      .addDropdown(drop =>
        drop
          .addOption('0', 'On change (debounced 30 s)')
          .addOption('1', 'Every 1 minute')
          .addOption('2', 'Every 2 minutes')
          .addOption('5', 'Every 5 minutes')
          .addOption('10', 'Every 10 minutes')
          .addOption('15', 'Every 15 minutes')
          .addOption('30', 'Every 30 minutes')
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async value => {
            this.plugin.settings.syncInterval = Number(value);
            await this.plugin.saveSettings();
            this.plugin.setupSync();
          }),
      );

    new Setting(containerEl)
      .setName('Conflict resolution')
      .setDesc('What to do when both sides changed the same note.')
      .addDropdown(drop =>
        drop
          .addOption('last-write-wins', 'Last write wins')
          .addOption('obsidian-wins', 'Obsidian always wins')
          .addOption('outline-wins', 'Outline always wins')
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value: ConflictResolution) => {
            this.plugin.settings.conflictResolution = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Inbox collection')
      .setDesc('Notes in the vault root (no subfolder) are synced to this Outline collection.')
      .addText(text =>
        text
          .setPlaceholder('Inbox')
          .setValue(this.plugin.settings.inboxCollection)
          .onChange(async value => {
            this.plugin.settings.inboxCollection = value.trim() || 'Inbox';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Ignored paths')
      .setDesc('Comma-separated list of folders or files to exclude (e.g. Templates, Attachments).')
      .addTextArea(text =>
        text
          .setValue(this.plugin.settings.ignorePaths.join(', '))
          .onChange(async value => {
            this.plugin.settings.ignorePaths = value
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    // ── Initial sync ─────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Initial sync' });

    const firstDone = this.plugin.settings.syncState.firstSyncDone;

    new Setting(containerEl)
      .setName('First-sync direction')
      .setDesc(
        firstDone
          ? 'First sync already completed — always bidirectional from now on.'
          : 'Choose which side is authoritative for the very first sync. After that, sync is always bidirectional.',
      )
      .addDropdown(drop => {
        drop
          .addOption('bidirectional', 'Bidirectional (merge both sides)')
          .addOption('obsidian-to-outline', 'Obsidian → Outline (push local notes)')
          .addOption('outline-to-obsidian', 'Outline → Obsidian (pull remote notes)')
          .setValue(this.plugin.settings.initialSyncDirection)
          .setDisabled(firstDone)
          .onChange(async (value: InitialSyncDirection) => {
            this.plugin.settings.initialSyncDirection = value;
            await this.plugin.saveSettings();
          });
      });

    if (firstDone) {
      new Setting(containerEl)
        .setName('Reset sync state')
        .setDesc('Clears all sync mappings and resets the first-sync flag. Use with caution — the next sync will re-evaluate all documents.')
        .addButton(btn =>
          btn
            .setButtonText('Reset')
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.syncState = {
                lastSyncTime: 0,
                fileHashes: {},
                outlineIdMap: {},
                pathToOutlineId: {},
                firstSyncDone: false,
              };
              await this.plugin.saveSettings();
              new Notice('Sync state reset. Choose a first-sync direction and sync again.');
              this.display();
            }),
        );
    }

    // ── Danger zone ─────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Danger zone' });

    new Setting(containerEl)
      .setName('Reset Outline')
      .setDesc('Deletes all tracked documents from Outline and resets the sync state. Use this before a clean first sync from Obsidian.')
      .addButton(btn => {
        btn.setButtonText('Reset Outline').setWarning();
        let confirmed = false;
        btn.onClick(async () => {
          if (!confirmed) {
            confirmed = true;
            btn.setButtonText('Sicher? Nochmal klicken');
            setTimeout(() => {
              confirmed = false;
              btn.setButtonText('Reset Outline');
            }, 4000);
            return;
          }

          btn.setDisabled(true).setButtonText('Wird gelöscht…');
          const state = this.plugin.settings.syncState;
          const ids = Object.keys(state.outlineIdMap);
          let deleted = 0;
          let failed = 0;

          for (const id of ids) {
            try {
              await this.plugin.syncEngine.deleteOutlineDoc(id);
              deleted++;
            } catch {
              failed++;
            }
          }

          this.plugin.settings.syncState = {
            lastSyncTime: 0,
            fileHashes: {},
            outlineIdMap: {},
            pathToOutlineId: {},
            firstSyncDone: false,
          };
          await this.plugin.saveSettings();

          btn.setDisabled(false).setButtonText('Reset Outline');
          new Notice(
            `Outline reset: ${deleted} Dokumente gelöscht${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}. Sync state zurückgesetzt.`,
            8000,
          );
          this.display();
        });
      });

    // ── Status ───────────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Status' });

    const lastSync = this.plugin.settings.syncState.lastSyncTime;
    const trackedCount = Object.keys(this.plugin.settings.syncState.outlineIdMap).length;

    new Setting(containerEl)
      .setName('Last sync')
      .setDesc(lastSync > 0 ? new Date(lastSync).toLocaleString() : 'Never');

    new Setting(containerEl)
      .setName('Tracked documents')
      .setDesc(String(trackedCount));

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Trigger an immediate sync.')
      .addButton(btn =>
        btn
          .setButtonText('Sync now')
          .setCta()
          .onClick(() => this.plugin.runSync()),
      );
  }
}
