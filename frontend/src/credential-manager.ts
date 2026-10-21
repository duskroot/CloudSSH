import { onLocaleChange, t } from './i18n';
import { isEncryptedPrivateKey, unlockPrivateKey } from './private-key-unlock';
import { preparePrivateKey } from './private-key-import';
import { confirmAction, notify } from './ui-feedback';

export interface SavedCredential {
  id: number;
  name: string;
  username: string;
  auth_method: 'password' | 'publickey';
  created_at: number;
  updated_at: number;
  server_count: number;
}

type CredentialKind = 'password' | 'key';

export class CredentialManager {
  private credentials: SavedCredential[] = [];
  private query = '';
  private editingId: number | null = null;
  private kind: CredentialKind = 'password';
  private onChange: (() => void) | null = null;

  constructor(onChange?: () => void) {
    this.onChange = onChange ?? null;
    this.bind();
    onLocaleChange(() => {
      this.render();
      this.applyKind();
    });
    void this.reload();
  }

  getAll(): readonly SavedCredential[] {
    return this.credentials;
  }

  async reload(): Promise<void> {
    const res = await fetch('/api/credentials');
    if (!res.ok) return;
    const rows = (await res.json()) as SavedCredential[];
    this.credentials = Array.isArray(rows) ? rows : [];
    this.render();
    this.onChange?.();
  }

  private bind(): void {
    document.getElementById('workspace-tab-servers')?.addEventListener('click', () => {
      this.showWorkspace('servers');
    });
    document.getElementById('workspace-tab-credentials')?.addEventListener('click', () => {
      this.showWorkspace('credentials');
    });
    document.getElementById('add-credential-btn')?.addEventListener('click', () => this.open());
    document.getElementById('credential-modal-close')?.addEventListener('click', () => this.close());
    document.getElementById('credential-cancel-btn')?.addEventListener('click', () => this.close());
    document.getElementById('credential-modal-backdrop')?.addEventListener('click', () => this.close());
    document.getElementById('credential-type-password')?.addEventListener('click', () => this.setKind('password'));
    document.getElementById('credential-type-key')?.addEventListener('click', () => this.setKind('key'));
    document.getElementById('credential-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.save();
    });
    document.getElementById('credential-search')?.addEventListener('input', (event) => {
      this.query = (event.target as HTMLInputElement).value;
      this.render();
    });
    document.getElementById('credential-key-file')?.addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const text = await file.text();
      const area = document.getElementById('credential-key') as HTMLTextAreaElement | null;
      if (area) area.value = text;
    });
    document.getElementById('credential-table-body')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const edit = target.closest('[data-credential-edit]') as HTMLElement | null;
      const remove = target.closest('[data-credential-delete]') as HTMLElement | null;
      if (edit?.dataset.credentialEdit) this.open(Number(edit.dataset.credentialEdit));
      if (remove?.dataset.credentialDelete) void this.remove(Number(remove.dataset.credentialDelete));
    });
  }

  private showWorkspace(which: 'servers' | 'credentials'): void {
    const servers = document.getElementById('server-workspace');
    const credentials = document.getElementById('credential-workspace');
    const serverTab = document.getElementById('workspace-tab-servers');
    const credentialTab = document.getElementById('workspace-tab-credentials');
    const addServer = document.getElementById('add-server-btn');
    const addCredential = document.getElementById('add-credential-btn');
    const subtitle = document.getElementById('workspace-subtitle');
    const showingCredentials = which === 'credentials';
    servers?.classList.toggle('hidden', showingCredentials);
    credentials?.classList.toggle('hidden', !showingCredentials);
    addServer?.classList.toggle('hidden', showingCredentials);
    addCredential?.classList.toggle('hidden', !showingCredentials);
    addCredential?.classList.toggle('flex', showingCredentials);
    serverTab?.classList.toggle('workspace-tab-active', !showingCredentials);
    credentialTab?.classList.toggle('workspace-tab-active', showingCredentials);
    serverTab?.setAttribute('aria-selected', String(!showingCredentials));
    credentialTab?.setAttribute('aria-selected', String(showingCredentials));
    if (subtitle) {
      const key = showingCredentials ? 'credential.subtitle' : 'server.manage';
      subtitle.dataset.i18n = key;
      subtitle.textContent = t(key);
    }
  }

  private setKind(kind: CredentialKind): void {
    this.kind = kind;
    this.applyKind();
  }

  private applyKind(): void {
    const password = document.getElementById('credential-password-section');
    const key = document.getElementById('credential-key-section');
    password?.classList.toggle('hidden', this.kind !== 'password');
    key?.classList.toggle('hidden', this.kind !== 'key');
    document.getElementById('credential-type-password')?.classList.toggle('auth-tab-active', this.kind === 'password');
    document.getElementById('credential-type-key')?.classList.toggle('auth-tab-active', this.kind === 'key');
  }

  private open(id?: number): void {
    const existing = id ? this.credentials.find((item) => item.id === id) : undefined;
    this.editingId = existing?.id ?? null;
    this.kind = existing?.auth_method === 'publickey' ? 'key' : 'password';
    const title = document.getElementById('credential-modal-title');
    if (title) title.textContent = t(existing ? 'credential.editTitle' : 'credential.createTitle');
    (document.getElementById('credential-name') as HTMLInputElement).value = existing?.name ?? '';
    (document.getElementById('credential-username') as HTMLInputElement).value = existing?.username ?? '';
    (document.getElementById('credential-password') as HTMLInputElement).value = '';
    (document.getElementById('credential-key') as HTMLTextAreaElement).value = '';
    (document.getElementById('credential-passphrase') as HTMLInputElement).value = '';
    document.getElementById('credential-keep-hint')?.classList.toggle('hidden', !existing);
    this.applyKind();
    const modal = document.getElementById('credential-modal');
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
    (document.getElementById('credential-name') as HTMLInputElement).focus();
  }

  private close(): void {
    const modal = document.getElementById('credential-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
    this.editingId = null;
  }

  private async save(): Promise<void> {
    const name = (document.getElementById('credential-name') as HTMLInputElement).value.trim();
    const username = (document.getElementById('credential-username') as HTMLInputElement).value.trim();
    const authMethod = this.kind === 'key' ? 'publickey' : 'password';
    let secret =
      this.kind === 'key'
        ? (document.getElementById('credential-key') as HTMLTextAreaElement).value
        : (document.getElementById('credential-password') as HTMLInputElement).value;
    if (!name || !username || (!secret && this.editingId === null)) {
      notify(t('credential.required'), { variant: 'warning' });
      return;
    }
    if (authMethod === 'publickey' && secret) {
      const passphrase = (document.getElementById('credential-passphrase') as HTMLInputElement).value;
      if (isEncryptedPrivateKey(secret) && passphrase) {
        const approved = await confirmAction({
          title: t('auth.keyUnlockTitle'),
          message: t('auth.keyUnlockSaveWarning'),
          variant: 'warning',
        });
        if (!approved) return;
        try {
          secret = await unlockPrivateKey(secret, passphrase);
        } catch {
          notify(t('auth.keyUnlockError'), { variant: 'danger' });
          return;
        }
      } else {
        const prepared = await preparePrivateKey(secret, true);
        if (!prepared) return;
        secret = prepared.key;
      }
    }
    const body: Record<string, string> = { name, username, auth_method: authMethod };
    if (secret) body.credential = secret;
    const editingId = this.editingId;
    const res = await fetch(editingId ? `/api/credentials/${editingId}` : '/api/credentials', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      notify(err.error || t('feedback.danger'), { variant: 'danger' });
      return;
    }
    notify(t('credential.saved'), { variant: 'success' });
    this.close();
    await this.reload();
  }

  private async remove(id: number): Promise<void> {
    const item = this.credentials.find((credential) => credential.id === id);
    if (!item) return;
    const confirmed = await confirmAction({
      title: t('credential.deleteTitle'),
      message: t('credential.deleteMessage', { name: item.name }),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await fetch(`/api/credentials/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      notify(err.error || t('feedback.danger'), { variant: 'danger' });
      return;
    }
    await this.reload();
  }

  private render(): void {
    const body = document.getElementById('credential-table-body');
    const empty = document.getElementById('credential-empty');
    const table = document.querySelector('.credential-table-wrap');
    if (!body || !empty || !table) return;
    const query = this.query.trim().toLocaleLowerCase();
    const rows = this.credentials.filter((item) => !query || item.name.toLocaleLowerCase().includes(query));
    body.replaceChildren();
    const showEmpty = rows.length === 0;
    empty.classList.toggle('hidden', !showEmpty);
    empty.classList.toggle('flex', showEmpty);
    table.classList.toggle('hidden', showEmpty && this.credentials.length === 0);
    if (showEmpty && this.credentials.length > 0) {
      const first = empty.querySelector('p');
      if (first) first.textContent = t('credential.noMatches');
    } else if (showEmpty) {
      const first = empty.querySelector('p');
      if (first) first.textContent = t('credential.empty');
    }
    for (const item of rows) {
      const tr = document.createElement('tr');
      tr.append(
        cell(item.name),
        cell(item.username),
        typeCell(item.auth_method),
        cell(formatStamp(item.created_at)),
        actionCell(item.id)
      );
      body.append(tr);
    }
  }
}

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function typeCell(method: SavedCredential['auth_method']): HTMLTableCellElement {
  const td = document.createElement('td');
  const wrap = document.createElement('span');
  wrap.className = 'inline-flex items-center gap-2 text-[var(--accent-secondary)]';
  const dot = document.createElement('span');
  dot.className = 'credential-type-dot';
  wrap.append(dot, document.createTextNode(t(method === 'publickey' ? 'credential.publickey' : 'credential.password')));
  td.append(wrap);
  return td;
}

function actionCell(id: number): HTMLTableCellElement {
  const td = document.createElement('td');
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'text-[12px] text-primary mr-3';
  edit.dataset.credentialEdit = String(id);
  edit.textContent = t('common.edit');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-[12px] text-error';
  remove.dataset.credentialDelete = String(id);
  remove.textContent = t('common.delete');
  td.append(edit, remove);
  return td;
}

function formatStamp(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
