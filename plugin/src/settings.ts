import { App, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import type ObslinePlugin from './main';
import { ConflictResolution, InitialSyncDirection } from './types';
import { sanitizeAttachmentFolder } from './embeds';

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

    // ── Attachments ───────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Attachments' });

    containerEl.createEl('p', {
      text: 'Sync embedded images and files in both directions. Embeds are rewritten between ' +
        'Obsidian syntax and Outline attachment URLs; downloaded files land in the folder below.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Sync attachments')
      .setDesc('Upload local embeds to Outline and download Outline attachments into the vault.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.syncAttachments)
          .onChange(async value => {
            this.plugin.settings.syncAttachments = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Attachment folder')
      .setDesc('Vault-relative folder where attachments pulled from Outline are stored. ' +
        'Avoid dot-folders — Obsidian hides them and embeds won\'t render.')
      .addText(text => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async value => {
            this.plugin.settings.attachmentFolder = value.trim().replace(/\/+$/, '') || 'attachments';
            await this.plugin.saveSettings();
          });
        // Normalise on blur (not per keystroke): strip leading dots so the folder stays visible to Obsidian.
        text.inputEl.addEventListener('blur', async () => {
          const clean = sanitizeAttachmentFolder(this.plugin.settings.attachmentFolder);
          if (clean !== this.plugin.settings.attachmentFolder) {
            this.plugin.settings.attachmentFolder = clean;
            text.setValue(clean);
            await this.plugin.saveSettings();
            new Notice('Obsidian blendet Ordner mit führendem Punkt aus — der Punkt wurde entfernt.');
          }
        });
      });

    new Setting(containerEl)
      .setName('Clean up orphaned attachments')
      .setDesc('When enabled, delete attachments in Outline that no synced document references anymore. ' +
        'Off by default — deletions are irreversible.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.cleanupOrphanAttachments)
          .onChange(async value => {
            this.plugin.settings.cleanupOrphanAttachments = value;
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


    // ── Danger zone ─────────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Danger zone' });

    new Setting(containerEl)
      .setName('Sync State zurücksetzen')
      .setDesc('Löscht nur das lokale Tracking — Outline-Daten bleiben vollständig erhalten. Ideal wenn du einen neuen PC einrichtest und Obsidian mit den bestehenden Outline-Daten befüllen möchtest.')
      .addButton(btn => {
        btn.setButtonText('Sync State zurücksetzen').setWarning();
        let confirmed = false;
        btn.onClick(async () => {
          if (!confirmed) {
            confirmed = true;
            btn.setButtonText('Sicher? Nochmal klicken');
            setTimeout(() => { confirmed = false; btn.setButtonText('Sync State zurücksetzen'); }, 4000);
            return;
          }
          this.plugin.settings.syncState = {
            lastSyncTime: 0, fileHashes: {}, outlineIdMap: {}, pathToOutlineId: {}, outlineUpdatedAt: {},
            attachments: { idToPath: {}, pathToId: {}, binHashes: {} }, firstSyncDone: false,
          };
          await this.plugin.saveSettings();
          new Notice('Sync State zurückgesetzt. Outline-Daten sind noch online vorhanden.');
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Alles in Outline löschen')
      .setDesc('⚠️ Löscht ALLE Sammlungen und Dokumente in Outline. Danach ist alles online weg! Nutze dies für eine cleane Umgebung vor einem First Sync von Obsidian.')
      .addButton(btn => {
        btn.setButtonText('Alles in Outline löschen').setWarning();
        let confirmed = false;
        btn.onClick(async () => {
          if (!confirmed) {
            confirmed = true;
            btn.setButtonText('⚠️ Sicher? Alles wird gelöscht!');
            setTimeout(() => { confirmed = false; btn.setButtonText('Alles in Outline löschen'); }, 4000);
            return;
          }

          btn.setDisabled(true).setButtonText('Wird gelöscht…');
          const { deleted, failed } = await this.plugin.syncEngine.deleteAllOutline();

          this.plugin.settings.syncState = {
            lastSyncTime: 0, fileHashes: {}, outlineIdMap: {}, pathToOutlineId: {}, outlineUpdatedAt: {},
            attachments: { idToPath: {}, pathToId: {}, binHashes: {} }, firstSyncDone: false,
          };
          await this.plugin.saveSettings();

          btn.setDisabled(false).setButtonText('Alles in Outline löschen');
          new Notice(
            `Outline geleert: ${deleted} Sammlungen gelöscht${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}. Sync State zurückgesetzt.`,
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
