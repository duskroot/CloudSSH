import { MYSQL_CHARSETS, defaultDbPort, type DbEngine, privilegesFor } from '../../src/db-admin';
import { onLocaleChange, t } from './i18n';
import { populateRegionSelect, regionLabel } from './regions';
import { confirmAction, notify } from './ui-feedback';

interface DbArchive {
  id: number;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  username: string;
  remark?: string;
  region?: string;
  inferred_hint?: string | null;
}

const ENGINE_LABEL: Record<DbEngine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

export class DbDrawer {
  private archives: DbArchive[] = [];
  private selectedId: number | null = null;
  private editingId: number | null = null;
  private view: 'list' | 'manage' = 'list';
  private databases: string[] = [];
  private users: string[] = [];
  private section: 'databases' | 'accounts' = 'databases';
  private query = '';
  private page = 1;
  private databaseError = '';
  private accountError = '';
  private redisOpen = new Set<number>();
  private redisKeys: Record<number, string[] | undefined> = {};
  private redisKey = '';
  private redisDb = 0;
  private redisDetail: string[] = [];
  private redisError = '';
  private redisInfo: string[] = [];
  private redisInfoError = '';
  private redisInfoShown = 16;
  private redisDbCount = 16;
  private redisAuto = false;
  private redisTimer: number | null = null;
  private redisSearchTimer: number | null = null;
  private bound = false;
  private localeCleanup: (() => void) | null = null;

  constructor() {
    this.localeCleanup = onLocaleChange(() => {
      if (document.getElementById('database-workspace') && !document.getElementById('database-workspace')?.classList.contains('hidden')) {
        this.paint();
      }
    });
  }

  isOpen(): boolean {
    return false;
  }

  refresh(): void {
    this.bind();
    void this.reload();
  }

  open(): void {}

  close(): void {}

  toggle(): void {}

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    document.getElementById('add-database-btn')?.addEventListener('click', () => this.openForm());
    document.getElementById('empty-add-database-btn')?.addEventListener('click', () => this.openForm());
    document.getElementById('db-connection-modal-close')?.addEventListener('click', () => this.closeForm());
    document.getElementById('db-connection-cancel')?.addEventListener('click', () => this.closeForm());
    document.getElementById('db-connection-modal-backdrop')?.addEventListener('click', () => this.closeForm());
    document.getElementById('db-archive-engine')?.addEventListener('change', (event) => {
      const engine = (event.target as HTMLSelectElement).value as DbEngine;
      const port = document.getElementById('db-archive-port') as HTMLInputElement | null;
      if (port) port.value = String(defaultDbPort(engine));
    });
    document.getElementById('db-connection-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveForm();
    });
    document.getElementById('database-workspace')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest('[data-db-action]') as HTMLElement | null;
      if (!action?.dataset.dbAction) return;
      const current = this.archives.find((item) => item.id === this.selectedId) || null;
      if (action.dataset.dbAction === 'section') {
        this.section = action.dataset.dbSection === 'accounts' ? 'accounts' : 'databases';
        this.query = '';
        this.page = 1;
        const search = document.getElementById('db-manage-search') as HTMLInputElement | null;
        if (search) search.value = '';
        this.paintLists();
        return;
      }
      if (action.dataset.dbAction === 'page-prev') {
        this.page = Math.max(1, this.page - 1);
        this.paintLists();
        return;
      }
      if (action.dataset.dbAction === 'page-next') {
        this.page += 1;
        this.paintLists();
        return;
      }
      if (!current) {
        const id = Number(action.dataset.dbId);
        const archive = this.archives.find((item) => item.id === id);
        if (!archive) return;
        if (action.dataset.dbAction === 'manage') this.enter(archive);
        if (action.dataset.dbAction === 'edit') this.openForm(archive);
        if (action.dataset.dbAction === 'delete') void this.remove(archive);
        return;
      }
      const name = action.dataset.dbValue || '';
      if (action.dataset.dbAction === 'create-database') this.openTask(current, 'create-database');
      if (action.dataset.dbAction === 'create-account') this.openTask(current, 'create-account');
      if (action.dataset.dbAction === 'reset-password') this.openTask(current, 'reset-password', name);
      if (action.dataset.dbAction === 'edit-priv') this.openTask(current, 'edit-priv', name);
      if (action.dataset.dbAction === 'drop-database') void this.dropNamed(current, 'drop_database', name, 'db.dropDatabaseConfirm');
      if (action.dataset.dbAction === 'drop-user') void this.dropNamed(current, 'drop_user', name, 'db.dropAccountConfirm');
      if (action.dataset.dbAction === 'flush-database') void this.flushNamed(current, name);
      if (action.dataset.dbAction === 'redis-toggle') {
        const index = Number(action.dataset.dbIndex);
        if (this.redisOpen.has(index)) this.redisOpen.delete(index);
        else {
          this.redisOpen.add(index);
          if (!this.redisKeys[index]) void this.run(current, 'list_redis_keys', { redisDb: index, name: this.query });
        }
        this.paintRedis();
        return;
      }
      if (action.dataset.dbAction === 'redis-key') {
        this.redisDb = Number(action.dataset.dbIndex);
        this.redisKey = action.dataset.dbValue || '';
        this.redisDetail = [];
        void this.run(current, 'get_redis_key', { redisDb: this.redisDb, name: this.redisKey });
        return;
      }
      if (action.dataset.dbAction === 'redis-overview') {
        this.redisKey = '';
        this.redisDetail = [];
        this.paintRedis();
        return;
      }
      if (action.dataset.dbAction === 'redis-refresh') {
        void this.run(current, 'redis_info', {}, true);
        void this.run(current, 'list_redis_keys', { redisDb: this.redisDb, name: this.query }, true);
        if (this.redisKey) void this.run(current, 'get_redis_key', { redisDb: this.redisDb, name: this.redisKey }, true);
        return;
      }
      if (action.dataset.dbAction === 'redis-more') {
        this.redisInfoShown += 24;
        this.paintRedis();
        return;
      }
      if (action.dataset.dbAction === 'redis-all') {
        this.redisInfoShown = 600;
        this.paintRedis();
        return;
      }
      if (action.dataset.dbAction === 'redis-new') {
        this.openRedisKey(current);
        return;
      }
      if (action.dataset.dbAction === 'redis-delete') {
        void this.deleteRedisKey(current);
        return;
      }
      if (action.dataset.dbAction === 'redis-select-db') {
        this.openRedisDatabase(Number(action.dataset.dbIndex));
        return;
      }
      const id = Number(action.dataset.dbId);
      if (action.dataset.dbAction === 'back') {
        this.stopRedisTimer();
        this.view = 'list';
        this.selectedId = null;
        this.paint();
        return;
      }
      const archive = this.archives.find((item) => item.id === id);
      if (!archive) return;
      if (action.dataset.dbAction === 'manage') this.enter(archive);
      if (action.dataset.dbAction === 'edit') this.openForm(archive);
      if (action.dataset.dbAction === 'delete') void this.remove(archive);
    });
  }

  private async reload(): Promise<void> {
    const response = await fetch('/api/db-archives');
    if (!response.ok) return;
    this.archives = await response.json() as DbArchive[];
    if (this.selectedId && !this.archives.some((item) => item.id === this.selectedId)) {
      this.selectedId = null;
      this.view = 'list';
    }
    this.paint();
  }

  private paint(): void {
    const grid = document.getElementById('database-grid');
    const empty = document.getElementById('database-empty');
    const manage = document.getElementById('database-manage');
    if (!grid || !empty || !manage) return;
    const selected = this.archives.find((item) => item.id === this.selectedId) || null;
    const showingManage = this.view === 'manage' && selected;
    grid.classList.toggle('hidden', Boolean(showingManage) || this.archives.length === 0);
    empty.classList.toggle('hidden', Boolean(showingManage) || this.archives.length > 0);
    empty.classList.toggle('flex', !showingManage && this.archives.length === 0);
    manage.classList.toggle('hidden', !showingManage);
    if (showingManage && selected) {
      manage.replaceChildren(this.manageView(selected));
      return;
    }
    grid.innerHTML = this.archives.map((archive, index) => this.card(archive, index)).join('');
  }

  private card(archive: DbArchive, index: number): string {
    const remark = archive.remark
      ? `<div class="server-card-meta-row flex items-center gap-2 min-w-0">
          <span class="text-dim">${escapeHtml(t('common.remark'))}</span>
          <span class="text-on-surface min-w-0 truncate" title="${escapeAttr(archive.remark)}">${escapeHtml(archive.remark)}</span>
        </div>`
      : '';
    return `
      <div class="server-card p-5 relative group server-card--enter cursor-pointer" style="--stagger-index: ${index}" data-db-action="manage" data-db-id="${archive.id}">
        <div class="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[var(--border-strong)] to-transparent group-hover:via-[var(--accent)] transition-all duration-300"></div>
        <div class="flex items-start justify-between gap-2 mb-3">
          <h3 class="server-card-title text-sm font-bold text-primary tracking-[0.05em] truncate min-w-0" title="${escapeAttr(archive.name)}">${escapeHtml(archive.name)}</h3>
          <span class="shrink-0 text-[10px] font-bold tracking-[0.1em] text-muted border border-dim px-2 py-0.5">${escapeHtml(ENGINE_LABEL[archive.engine] || archive.engine)}</span>
        </div>
        <div class="space-y-1.5 text-xs text-muted mb-4">
          <div class="server-card-meta-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${escapeHtml(t('db.host'))}</span>
            <span class="text-on-surface min-w-0 truncate">${escapeHtml(archive.host)}:${archive.port}</span>
          </div>
          <div class="server-card-meta-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${escapeHtml(t('db.adminUser'))}</span>
            <span class="text-on-surface min-w-0 truncate">${escapeHtml(archive.username)}</span>
          </div>
          ${remark}
          <div class="server-card-meta-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${escapeHtml(t('server.regionLabel'))}</span>
            <span class="text-on-surface min-w-0 truncate">${escapeHtml(regionLabel(archive.region || archive.inferred_hint))}</span>
          </div>
        </div>
        <div class="server-card-actions flex gap-2 pt-3 border-t border-[var(--border)]">
          <button type="button" class="cyber-button text-primary flex-1 min-w-0 py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-1" data-db-action="manage" data-db-id="${archive.id}">
            <span class="material-symbols-outlined" style="font-size: 14px;">database</span>
            ${escapeHtml(t('db.manage'))}
          </button>
          <button type="button" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" data-db-action="edit" data-db-id="${archive.id}" title="${escapeAttr(t('common.edit'))}">
            <span class="material-symbols-outlined" style="font-size: 14px;">edit</span>
          </button>
          <button type="button" class="cyber-button py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center text-error border-[var(--error)]" data-db-action="delete" data-db-id="${archive.id}" title="${escapeAttr(t('common.delete'))}">
            <span class="material-symbols-outlined" style="font-size: 14px;">delete</span>
          </button>
        </div>
      </div>`;
  }

  private enter(archive: DbArchive): void {
    this.selectedId = archive.id;
    this.view = 'manage';
    this.databases = [];
    this.users = [];
    this.section = 'databases';
    this.query = '';
    this.page = 1;
    this.databaseError = '';
    this.accountError = '';
    this.redisOpen.clear();
    this.redisKeys = {};
    this.redisKey = '';
    this.redisDetail = [];
    this.redisError = '';
    this.redisInfo = [];
    this.redisInfoError = '';
    this.redisInfoShown = 16;
    this.redisDbCount = 16;
    this.redisDb = 0;
    this.stopRedisTimer();
    this.redisAuto = false;
    this.paint();
    if (archive.engine === 'redis') {
      queueMicrotask(() => this.openRedisDatabase(0));
      return;
    }
    void this.run(archive, 'list_databases', {}, true);
    void this.run(archive, 'list_users', {}, true);
  }

  private manageView(selected: DbArchive): HTMLElement {
    const root = element('div', 'flex flex-col gap-4');
    const back = element('button', 'cyber-button px-3 py-1.5 text-xs flex items-center gap-1 self-start', '') as HTMLButtonElement;
    back.type = 'button';
    back.dataset.dbAction = 'back';
    back.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px">arrow_back</span>${escapeHtml(t('db.back'))}`;
    const summary = element('div', 'flex items-center gap-3 min-w-0');
    summary.innerHTML = `
      <h3 class="text-sm font-bold text-primary truncate">${escapeHtml(selected.name)}</h3>
      <span class="shrink-0 text-[10px] font-bold tracking-[0.1em] text-muted border border-dim px-2 py-0.5">${escapeHtml(ENGINE_LABEL[selected.engine])}</span>
      <span class="text-xs text-muted truncate">${escapeHtml(selected.username)}@${escapeHtml(selected.host)}:${selected.port}</span>`;
    const head = element('div', 'flex items-center justify-between gap-3');
    head.append(summary, back);

    const body = element('div', 'flex flex-col md:flex-row items-start gap-6');
    const aside = element('aside', 'server-group-sidebar shrink-0 flex flex-col gap-1');
    aside.id = 'db-section-nav';
    aside.append(
      tabButton('databases', 'db.databases', 'db-tab-databases', this.section === 'databases'),
      tabButton('accounts', 'db.users', 'db-tab-accounts', this.section === 'accounts')
    );
    const panel = element('section', 'server-card overflow-hidden flex-1 min-w-0');
    const toolbar = element('div', 'flex items-center justify-between gap-3 px-4 py-4');
    toolbar.id = 'db-manage-toolbar';
    const create = element('button', 'cyber-button text-primary px-4 py-2 text-xs font-bold', t('db.createDatabase')) as HTMLButtonElement;
    create.type = 'button';
    create.id = 'db-create-btn';
    create.dataset.dbAction = 'create-database';
    const search = input('search', '');
    search.id = 'db-manage-search';
    search.className = 'terminal-input text-[13px] w-full max-w-xs';
    search.placeholder = t('db.searchDatabase');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.page = 1;
      this.redisKeys = {};
      const current = this.archives.find((item) => item.id === this.selectedId);
      if (current?.engine === 'redis' && this.section === 'databases') {
        for (const index of this.redisOpen) void this.run(current, 'list_redis_keys', { redisDb: index, name: this.query });
      }
      this.paintLists();
    });
    toolbar.append(create, search);
    const tableWrap = element('div', 'credential-table-wrap overflow-x-auto');
    const table = document.createElement('table');
    table.className = 'credential-table w-full text-left text-[13px]';
    const thead = document.createElement('thead');
    thead.id = 'db-manage-head';
    const tbody = document.createElement('tbody');
    tbody.id = 'db-manage-body';
    table.append(thead, tbody);
    tableWrap.append(table);
    const footer = element('div', 'flex items-center justify-end gap-3 px-4 py-3 text-xs text-muted');
    footer.append(element('span', '', ''));
    footer.lastElementChild!.id = 'db-manage-total';
    const prev = element('button', 'cyber-button px-2 py-1 text-[11px]', t('server.previousPage')) as HTMLButtonElement;
    prev.type = 'button';
    prev.id = 'db-page-prev';
    prev.dataset.dbAction = 'page-prev';
    const info = element('span', '', '1 / 1');
    info.id = 'db-page-info';
    const next = element('button', 'cyber-button px-2 py-1 text-[11px]', t('server.nextPage')) as HTMLButtonElement;
    next.type = 'button';
    next.id = 'db-page-next';
    next.dataset.dbAction = 'page-next';
    footer.append(prev, info, next);
    const sql = element('div', '');
    sql.id = 'db-sql-panel';
    sql.append(tableWrap, footer);
    const browser = element('div', 'hidden grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] min-h-[36rem]');
    browser.id = 'db-redis-browser';
    const tree = element('div', 'border-r border-[var(--border)] flex flex-col min-h-[36rem]');
    tree.id = 'db-redis-tree';
    const side = element('div', 'p-3 flex flex-col gap-2 border-b border-[var(--border)]');
    const dbSelect = document.createElement('select');
    dbSelect.id = 'db-redis-select';
    dbSelect.className = 'terminal-input text-[13px] w-full';
    dbSelect.addEventListener('change', () => {
      this.openRedisDatabase(Number(dbSelect.value) || 0);
    });
    const createKey = element('button', 'cyber-button text-primary px-3 py-2 text-xs font-bold', t('db.redisNewKey')) as HTMLButtonElement;
    createKey.type = 'button';
    createKey.dataset.dbAction = 'redis-new';
    const keySearch = input('search', this.query);
    keySearch.id = 'db-redis-search';
    keySearch.placeholder = t('db.searchKey');
    keySearch.addEventListener('input', () => {
      this.query = keySearch.value;
      if (this.redisSearchTimer) window.clearTimeout(this.redisSearchTimer);
      this.redisSearchTimer = window.setTimeout(() => {
        const current = this.archives.find((item) => item.id === this.selectedId);
        if (current) void this.run(current, 'list_redis_keys', { redisDb: this.redisDb, name: this.query }, true);
      }, 250);
    });
    side.append(dbSelect, createKey, keySearch);
    const keys = element('div', 'flex-1 overflow-auto custom-scrollbar p-2');
    keys.id = 'db-redis-keys';
    tree.append(side, keys);
    const value = element('div', 'overflow-auto custom-scrollbar p-4');
    value.id = 'db-redis-value';
    browser.append(tree, value);
    panel.append(toolbar, sql, browser);
    body.append(aside, panel);
    root.append(head, body);
    queueMicrotask(() => this.paintLists());
    return root;
  }

  private paintLists(): void {
    const body = document.getElementById('db-manage-body');
    const head = document.getElementById('db-manage-head');
    if (!body || !head) return;
    const accounts = this.section === 'accounts';
    document.getElementById('db-tab-databases')?.classList.toggle('server-group-item-active', !accounts);
    document.getElementById('db-tab-accounts')?.classList.toggle('server-group-item-active', accounts);
    const archive = this.archives.find((item) => item.id === this.selectedId);
    const redis = archive?.engine === 'redis';
    const redisView = Boolean(redis);
    document.getElementById('db-section-nav')?.classList.toggle('hidden', redisView);
    document.getElementById('db-manage-toolbar')?.classList.toggle('hidden', redisView);
    document.getElementById('db-sql-panel')?.classList.toggle('hidden', redisView);
    document.getElementById('db-redis-browser')?.classList.toggle('hidden', !redisView);
    document.getElementById('db-redis-browser')?.classList.toggle('grid', redisView);
    const create = document.getElementById('db-create-btn');
    if (create) {
      create.classList.toggle('hidden', !accounts && Boolean(redis));
      create.textContent = t(accounts ? 'db.createUser' : 'db.createDatabase');
      create.dataset.dbAction = accounts ? 'create-account' : 'create-database';
    }
    const search = document.getElementById('db-manage-search') as HTMLInputElement | null;
    if (search) search.placeholder = t(redisView ? 'db.searchKey' : accounts ? 'db.searchAccount' : 'db.searchDatabase');
    if (redisView) {
      this.paintRedis();
      return;
    }
    const actionHeader = accounts
      ? `<th class="text-right" style="width:240px;padding-right:28px">${escapeHtml(t('db.colActions'))}</th>`
      : `<th>${escapeHtml(t('db.colActions'))}</th>`;
    head.innerHTML = accounts
      ? `<tr><th>${escapeHtml(t('db.colAccount'))}</th>${actionHeader}</tr>`
      : `<tr><th>${escapeHtml(t('db.colName'))}</th><th>${escapeHtml(t('db.colStatus'))}</th>${actionHeader}</tr>`;
    const source = (accounts ? this.users : this.databases).filter((name) => name.toLowerCase().includes(this.query.trim().toLowerCase()));
    const pages = Math.max(1, Math.ceil(source.length / 30));
    if (this.page > pages) this.page = pages;
    const slice = source.slice((this.page - 1) * 30, this.page * 30);
    body.replaceChildren();
    const loadError = accounts ? this.accountError : this.databaseError;
    if (slice.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = accounts ? 2 : 3;
      cell.className = loadError ? 'text-center text-error' : 'text-center text-dim';
      cell.textContent = loadError || t('db.emptyList');
      row.append(cell);
      body.append(row);
    } else {
      for (const name of slice) body.append(accounts ? accountRow(name) : databaseRow(name, Boolean(redis)));
    }
    const total = document.getElementById('db-manage-total');
    if (total) total.textContent = t('db.total').replace('{n}', String(source.length));
    const prev = document.getElementById('db-page-prev') as HTMLButtonElement | null;
    const next = document.getElementById('db-page-next') as HTMLButtonElement | null;
    if (prev) prev.disabled = this.page <= 1;
    if (next) next.disabled = this.page >= pages;
    const info = document.getElementById('db-page-info');
    if (info) info.textContent = `${this.page} / ${pages}`;
  }

  private paintRedis(): void {
    const list = document.getElementById('db-redis-keys');
    const value = document.getElementById('db-redis-value');
    const select = document.getElementById('db-redis-select') as HTMLSelectElement | null;
    if (!list || !value) return;
    const counts = redisKeyspace(this.redisInfo);
    const total = Math.max(1, Math.min(this.redisDbCount, 256));
    if (select) {
      const signature = `${total}:${counts.map((item) => `${item.db}:${item.keys}`).join(',')}`;
      if (select.dataset.signature !== signature) {
        select.replaceChildren();
        for (let index = 0; index < total; index += 1) {
          const found = counts.find((item) => item.index === index);
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = found ? `db${index} · ${found.keys}` : `db${index}`;
          select.append(option);
        }
        select.dataset.signature = signature;
      }
      if (select.value !== String(this.redisDb)) select.value = String(this.redisDb);
    }
    list.replaceChildren();
    if (this.redisError) list.append(element('p', 'text-xs text-error px-2 py-2', this.redisError));
    const query = this.query.trim().toLowerCase();
    const loaded = this.redisKeys[this.redisDb];
    const keys = (loaded || []).filter((key) => !query || key.toLowerCase().includes(query));
    if (!loaded) list.append(element('p', 'text-xs text-dim px-2 py-2', '…'));
    else if (keys.length === 0) list.append(element('p', 'text-xs text-dim px-2 py-2', t('db.redisEmptyKeys')));
    else {
      for (const key of keys) {
        const selected = this.redisKey === key;
        const keyButton = element('button', `w-full text-left text-[13px] px-2 py-1.5 truncate rounded ${selected ? 'text-primary font-bold' : ''}`, key) as HTMLButtonElement;
        keyButton.type = 'button';
        keyButton.title = key;
        keyButton.dataset.dbAction = 'redis-key';
        keyButton.dataset.dbIndex = String(this.redisDb);
        keyButton.dataset.dbValue = key;
        list.append(keyButton);
      }
    }
    value.replaceChildren();
    if (this.redisKey) {
      this.paintRedisKey(value);
      return;
    }
    this.paintRedisOverview(value, counts);
  }

  private openRedisDatabase(index: number): void {
    const current = this.archives.find((item) => item.id === this.selectedId);
    if (!current) return;
    this.redisDb = index;
    this.redisKey = '';
    this.redisDetail = [];
    this.redisInfo = [];
    this.redisInfoError = '';
    this.redisInfoShown = 16;
    delete this.redisKeys[index];
    const value = document.getElementById('db-redis-value');
    if (value) value.scrollTop = 0;
    this.paintRedis();
    void this.run(current, 'redis_info', {}, true);
    void this.run(current, 'list_redis_keys', { redisDb: index, name: this.query }, true);
  }

  private paintRedisKey(value: HTMLElement): void {
    const head = element('div', 'flex items-start justify-between gap-3 mb-4');
    const title = element('div', 'min-w-0');
    const back = element('button', 'text-xs text-primary mb-2', `db${this.redisDb}`) as HTMLButtonElement;
    back.type = 'button';
    back.dataset.dbAction = 'redis-overview';
    title.append(back, element('div', 'text-sm font-bold break-all', this.redisKey));
    const type = this.redisDetail[0] || '';
    const ttl = Number(this.redisDetail[1]);
    const meta = element('div', 'text-xs text-muted mt-1', '');
    if (type && type !== 'error') {
      const ttlText = ttl < 0 ? t(ttl === -2 ? 'db.redisTtlMissing' : 'db.redisTtlForever') : `${ttl}s`;
      meta.textContent = `${t('db.redisType')} ${type} · ${t('db.redisTtl')} ${ttlText}`;
    }
    title.append(meta);
    const actions = element('div', 'flex items-center gap-2 shrink-0');
    const refresh = element('button', 'cyber-button px-3 py-1.5 text-xs', t('db.refresh')) as HTMLButtonElement;
    refresh.type = 'button';
    refresh.dataset.dbAction = 'redis-refresh';
    const remove = element('button', 'cyber-button px-3 py-1.5 text-xs text-error border-[var(--error)]', t('common.delete')) as HTMLButtonElement;
    remove.type = 'button';
    remove.dataset.dbAction = 'redis-delete';
    actions.append(refresh, remove);
    head.append(title, actions);
    value.append(head);
    const lines = type === 'error' ? this.redisDetail.slice(1) : this.redisDetail.slice(2);
    if (type === 'error') {
      value.append(element('p', 'text-sm text-error', lines[0] || ''));
      return;
    }
    if (!type) {
      value.append(element('p', 'text-sm text-dim', '…'));
      return;
    }
    if (lines.some((line) => line.includes('\t'))) {
      value.append(redisPairTable(lines));
      return;
    }
    value.append(element('pre', 'text-[13px] whitespace-pre-wrap break-all rounded border border-[var(--border)] p-3', lines.join('\n') || '—'));
  }

  private paintRedisOverview(value: HTMLElement, counts: RedisKeyspace[]): void {
    const info = redisInfoMap(this.redisInfo);
    const bar = element('div', 'flex items-center justify-between gap-3 mb-4');
    const heading = element('div', '');
    heading.append(element('h4', 'text-sm font-bold', t('db.redisOverview')), element('div', 'text-xs text-muted mt-1', `db${this.redisDb}`));
    bar.append(heading);
    const tools = element('div', 'flex items-center gap-3');
    const refresh = element('button', 'cyber-button px-3 py-1.5 text-xs', t('db.refresh')) as HTMLButtonElement;
    refresh.type = 'button';
    refresh.dataset.dbAction = 'redis-refresh';
    const autoLabel = element('label', 'flex items-center gap-2 text-xs text-muted');
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = this.redisAuto;
    auto.className = 'accent-[var(--accent)]';
    auto.addEventListener('change', () => {
      this.redisAuto = auto.checked;
      this.armRedisTimer();
    });
    autoLabel.append(auto, document.createTextNode(t('db.redisAuto')));
    const flush = element('button', 'cyber-button px-3 py-1.5 text-xs text-error border-[var(--error)]', t('db.flush')) as HTMLButtonElement;
    flush.type = 'button';
    flush.dataset.dbAction = 'flush-database';
    flush.dataset.dbValue = `db${this.redisDb}`;
    tools.append(autoLabel, refresh, flush);
    bar.append(tools);
    value.append(bar);
    if (this.redisInfoError) value.append(element('p', 'text-sm text-error mb-3', this.redisInfoError));
    if (this.redisInfo.length === 0 && !this.redisInfoError) {
      value.append(element('p', 'text-sm text-dim', '…'));
      return;
    }
    const cards = element('div', 'grid grid-cols-1 xl:grid-cols-3 gap-3 mb-4');
    cards.append(
      redisStatCard(t('db.redisServer'), [
        [t('db.redisVersion'), info.redis_version],
        [t('db.redisOs'), info.os],
        [t('db.redisPid'), info.process_id],
      ]),
      redisStatCard(t('db.redisMemory'), [
        [t('db.redisUsedMemory'), info.used_memory_human],
        [t('db.redisPeakMemory'), info.used_memory_peak_human],
        [t('db.redisLuaMemory'), info.used_memory_lua_human || info.used_memory_scripts_human],
      ]),
      redisStatCard(t('db.redisStatus'), [
        [t('db.redisClients'), info.connected_clients],
        [t('db.redisConnections'), info.total_connections_received],
        [t('db.redisCommands'), info.total_commands_processed],
      ])
    );
    value.append(cards);
    value.append(element('h4', 'text-xs font-bold tracking-[0.08em] text-muted mb-2', t('db.redisKeyspace')));
    const space = document.createElement('table');
    space.className = 'credential-table w-full text-left text-[13px] mb-4';
    space.innerHTML = `<thead><tr><th>${escapeHtml(t('db.redisDb'))}</th><th>${escapeHtml(t('db.redisKeys'))}</th><th>${escapeHtml(t('db.redisExpires'))}</th><th>${escapeHtml(t('db.redisAvgTtl'))}</th></tr></thead>`;
    const spaceBody = document.createElement('tbody');
    const rows = counts.length > 0 ? counts : [];
    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'text-center text-dim';
      cell.textContent = t('db.redisEmptyKeys');
      row.append(cell);
      spaceBody.append(row);
    }
    for (const item of rows) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const button = element('button', 'text-primary', item.db) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.dbAction = 'redis-select-db';
      button.dataset.dbIndex = String(item.index);
      name.append(button);
      row.append(name, textCell(item.keys), textCell(item.expires), textCell(item.avgTtl));
      spaceBody.append(row);
    }
    space.append(spaceBody);
    value.append(space);
    value.append(element('h4', 'text-xs font-bold tracking-[0.08em] text-muted mb-2', t('db.redisInfo')));
    const infoLines = this.redisInfo.filter((line) => line.startsWith('info\t')).slice(0, this.redisInfoShown);
    const infoTable = document.createElement('table');
    infoTable.className = 'credential-table w-full text-left text-[13px]';
    infoTable.innerHTML = `<thead><tr><th>Key</th><th>Value</th></tr></thead>`;
    const infoBody = document.createElement('tbody');
    for (const line of infoLines) {
      const parts = line.split('\t');
      const row = document.createElement('tr');
      row.append(textCell(parts[2] || ''), textCell(parts.slice(3).join('\t')));
      infoBody.append(row);
    }
    infoTable.append(infoBody);
    value.append(infoTable);
    const more = element('div', 'flex items-center gap-2 mt-3');
    const totalInfo = this.redisInfo.filter((line) => line.startsWith('info\t')).length;
    if (this.redisInfoShown < totalInfo) {
      const loadMore = element('button', 'cyber-button px-3 py-1.5 text-xs', t('db.redisLoadMore')) as HTMLButtonElement;
      loadMore.type = 'button';
      loadMore.dataset.dbAction = 'redis-more';
      const loadAll = element('button', 'cyber-button px-3 py-1.5 text-xs text-error border-[var(--error)]', t('db.redisLoadAll')) as HTMLButtonElement;
      loadAll.type = 'button';
      loadAll.dataset.dbAction = 'redis-all';
      more.append(loadMore, loadAll);
    }
    value.append(more);
  }

  private openRedisKey(archive: DbArchive): void {
    const modal = ensureTaskModal();
    const title = document.getElementById('db-task-title');
    const body = document.getElementById('db-task-body');
    if (!title || !body) return;
    title.textContent = t('db.redisNewKey');
    body.replaceChildren();
    const form = element('form', 'space-y-4');
    const name = input('text', '');
    name.placeholder = t('db.redisKeyName');
    const field = document.createElement('textarea');
    field.className = 'terminal-input text-[13px] w-full';
    field.rows = 5;
    field.placeholder = t('db.redisKeyValue');
    form.append(labeled('db.redisKeyName', name), labeled('db.redisKeyValue', field));
    const actions = element('div', 'flex justify-end gap-3 pt-2');
    const cancel = element('button', 'cyber-button px-4 py-2 text-xs', t('common.cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => modal.classList.add('hidden'));
    actions.append(cancel, taskButton(t('common.confirm'), () => {
      const previous = this.redisKey;
      this.redisKey = name.value.trim();
      void this.run(archive, 'set_redis_key', { name: this.redisKey, value: field.value, redisDb: this.redisDb }).then((ok) => {
        if (ok) modal.classList.add('hidden');
        else this.redisKey = previous;
      });
    }));
    form.append(actions);
    form.addEventListener('submit', (event) => event.preventDefault());
    body.append(form);
    modal.classList.remove('hidden');
  }

  private async deleteRedisKey(archive: DbArchive): Promise<void> {
    if (!this.redisKey) return;
    const confirmed = await confirmAction({
      title: t('common.delete'),
      message: t('db.redisDeleteConfirm').replace('{name}', this.redisKey),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await this.run(archive, 'del_redis_key', { name: this.redisKey, redisDb: this.redisDb });
  }

  private armRedisTimer(): void {
    this.stopRedisTimer();
    if (!this.redisAuto) return;
    this.redisTimer = window.setInterval(() => {
      const current = this.archives.find((item) => item.id === this.selectedId);
      if (!current || current.engine !== 'redis' || this.view !== 'manage') {
        this.stopRedisTimer();
        return;
      }
      void this.run(current, 'redis_info', {}, true);
      void this.run(current, 'list_redis_keys', { redisDb: this.redisDb, name: this.query }, true);
    }, 8000);
  }

  private stopRedisTimer(): void {
    if (this.redisTimer) window.clearInterval(this.redisTimer);
    this.redisTimer = null;
  }

  private openTask(archive: DbArchive, kind: 'create-database' | 'create-account' | 'reset-password' | 'edit-priv', targetName = ''): void {
    const modal = ensureTaskModal();
    const title = document.getElementById('db-task-title');
    const body = document.getElementById('db-task-body');
    if (!title || !body) return;
    const titles = {
      'create-database': 'db.createDatabase',
      'create-account': 'db.createUser',
      'reset-password': 'db.resetPassword',
      'edit-priv': 'db.editPrivilege',
    } as const;
    title.textContent = t(titles[kind]);
    body.replaceChildren();
    const form = element('form', 'space-y-4');
    const name = input('text', kind === 'create-database' || kind === 'create-account' ? '' : targetName);
    name.placeholder = t(kind === 'create-database' ? 'db.colName' : 'db.colAccount');
    name.readOnly = kind === 'reset-password' || kind === 'edit-priv';
    const password = input('password', '');
    password.placeholder = t('db.userPassword');
    const database = document.createElement('select');
    database.className = 'terminal-input text-[13px] w-full';
    for (const item of this.databases) {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item;
      database.append(option);
    }
    const checks = element('div', 'flex flex-wrap gap-3 text-xs');
    for (const privilege of privilegesFor(archive.engine)) {
      const label = element('label', 'flex items-center gap-1');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = privilege;
      label.append(box, document.createTextNode(privilege));
      checks.append(label);
    }
    const charset = document.createElement('select');
    charset.className = 'terminal-input text-[13px] w-full';
    if (kind === 'create-database' && archive.engine === 'mysql') {
      for (const item of MYSQL_CHARSETS) {
        const option = document.createElement('option');
        option.value = item.collation;
        option.textContent = `${item.charset} / ${item.collation}`;
        charset.append(option);
      }
    }
    if (kind !== 'reset-password') form.append(labeled(kind === 'create-database' ? 'db.colName' : 'db.colAccount', name));
    if (kind === 'create-database' && archive.engine === 'mysql') form.append(labeled('db.charset', charset));
    if (kind === 'create-account' || kind === 'reset-password') form.append(labeled('db.userPassword', password));
    if (kind === 'create-account' || kind === 'edit-priv') {
      if (archive.engine !== 'redis') form.append(labeled('db.databaseName', database));
      form.append(checks);
    }
    const actions = element('div', 'flex justify-end gap-3 pt-2');
    const cancel = element('button', 'cyber-button px-4 py-2 text-xs', t('common.cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => modal.classList.add('hidden'));
    if (kind === 'edit-priv') {
      actions.append(
        cancel,
        taskButton(t('db.revoke'), () => this.submitTask(archive, modal, 'revoke', name.value, password.value, database.value, checked(checks))),
        taskButton(t('db.grant'), () => this.submitTask(archive, modal, 'grant', name.value, password.value, database.value, checked(checks)))
      );
    } else {
      const op = kind === 'create-database' ? 'create_database' : kind === 'reset-password' ? 'reset_password' : 'create_user';
      actions.append(cancel, taskButton(t('common.confirm'), () => this.submitTask(archive, modal, op, name.value || targetName, password.value, database.value, checked(checks), charset.value)));
    }
    form.append(actions);
    form.addEventListener('submit', (event) => event.preventDefault());
    body.append(form);
    modal.classList.remove('hidden');
  }

  private async submitTask(archive: DbArchive, modal: HTMLElement, op: string, name: string, password: string, database: string, privileges: string[], charset = ''): Promise<void> {
    const ok = await this.run(archive, op, { name, password, database, privileges, confirm: name, charset });
    if (ok) modal.classList.add('hidden');
  }

  private async dropNamed(archive: DbArchive, op: 'drop_database' | 'drop_user', name: string, messageKey: 'db.dropDatabaseConfirm' | 'db.dropAccountConfirm'): Promise<void> {
    const confirmed = await confirmAction({
      title: t('common.delete'),
      message: t(messageKey).replace('{name}', name),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await this.run(archive, op, { name, confirm: name });
  }

  private async flushNamed(archive: DbArchive, name: string): Promise<void> {
    const confirmed = await confirmAction({
      title: t('db.flush'),
      message: t('db.flushConfirm').replace('{name}', name),
      confirmText: t('db.flush'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    const index = Number(name.replace(/\D/g, ''));
    await this.run(archive, 'flush_redis', { confirm: 'FLUSH', redisDb: Number.isInteger(index) ? index : 0 });
  }

  private openForm(archive?: DbArchive): void {
    this.editingId = archive?.id ?? null;
    const title = document.getElementById('db-connection-modal-title');
    if (title) title.textContent = t(archive ? 'db.editTitle' : 'db.createTitle');
    setValue('db-archive-name', archive?.name || '');
    setValue('db-archive-engine', archive?.engine || 'postgres');
    setValue('db-archive-host', archive?.host || '');
    setValue('db-archive-port', String(archive?.port || defaultDbPort(archive?.engine || 'postgres')));
    setValue('db-archive-username', archive?.username || '');
    setValue('db-archive-password', '');
    setValue('db-archive-remark', archive?.remark || '');
    const region = document.getElementById('db-archive-region') as HTMLSelectElement | null;
    if (region) populateRegionSelect(region, archive?.region || '');
    document.getElementById('db-archive-keep-hint')?.classList.toggle('hidden', !archive);
    const modal = document.getElementById('db-connection-modal');
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
  }

  private closeForm(): void {
    document.getElementById('db-connection-modal')?.classList.add('hidden');
    this.editingId = null;
  }

  private async saveForm(): Promise<void> {
    const body = {
      name: valueOf('db-archive-name'),
      engine: valueOf('db-archive-engine'),
      host: valueOf('db-archive-host'),
      port: Number(valueOf('db-archive-port')),
      username: valueOf('db-archive-username'),
      password: valueOf('db-archive-password'),
      remark: valueOf('db-archive-remark'),
      region: valueOf('db-archive-region'),
    };
    const editing = this.editingId;
    const response = await fetch(editing ? `/api/db-archives/${editing}` : '/api/db-archives', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      notify(payload.error || t('feedback.danger'), { variant: 'danger' });
      return;
    }
    this.closeForm();
    await this.reload();
  }

  private async remove(archive: DbArchive): Promise<void> {
    const confirmed = await confirmAction({
      title: t('common.delete'),
      message: t('db.deleteConfirm'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await fetch(`/api/db-archives/${archive.id}`, { method: 'DELETE' });
    if (this.selectedId === archive.id) {
      this.selectedId = null;
      this.view = 'list';
    }
    await this.reload();
  }

  private async run(archive: DbArchive, op: string, payload: Record<string, unknown>, quiet = false): Promise<boolean> {
    try {
      const response = await fetch(`/api/db-archives/${archive.id}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
      });
      const result = await response.json() as { ok?: boolean; rows?: string[]; error?: string };
      if (!result.ok) {
        const message = result.error || t('feedback.danger');
        if (op === 'list_databases') this.databaseError = message;
        else if (op === 'list_users') this.accountError = message;
        else if (op === 'list_redis_keys') this.redisError = message;
        else if (op === 'get_redis_key') this.redisDetail = ['error', message];
        else if (op === 'redis_info') this.redisInfoError = message;
        if (op === 'list_databases' || op === 'list_users') this.paintLists();
        if (op === 'list_redis_keys' || op === 'get_redis_key' || op === 'redis_info') this.paintRedis();
        if (!quiet && op !== 'list_redis_keys' && op !== 'get_redis_key' && op !== 'redis_info') notify(message, { variant: 'danger' });
        return false;
      }
      if (op === 'list_redis_keys') {
        this.redisKeys[Number(payload.redisDb)] = result.rows || [];
        this.redisError = '';
        this.paintRedis();
        return true;
      }
      if (op === 'get_redis_key') {
        this.redisDetail = result.rows || [];
        this.paintRedis();
        return true;
      }
      if (op === 'redis_info') {
        this.redisInfo = result.rows || [];
        this.redisInfoError = '';
        const meta = this.redisInfo.find((line) => line.startsWith('meta\tdatabases\t'));
        const count = Number(meta?.split('\t')[2]);
        if (Number.isInteger(count) && count > 0) this.redisDbCount = count;
        this.paintRedis();
        return true;
      }
      if (op === 'list_databases') {
        this.databases = result.rows || [];
        this.databaseError = '';
      }
      if (op === 'list_users') {
        this.users = result.rows || [];
        this.accountError = '';
      }
      if (op === 'list_databases' || op === 'list_users') this.paintLists();
      if (!quiet && op !== 'list_databases' && op !== 'list_users' && op !== 'redis_info') notify(t('db.done'), { variant: 'success' });
      if (op === 'create_database' || op === 'drop_database' || (op === 'flush_redis' && archive.engine !== 'redis')) {
        await this.run(archive, 'list_databases', {}, true);
      }
      if (archive.engine === 'redis' && (op === 'set_redis_key' || op === 'del_redis_key' || op === 'flush_redis')) {
        if (op !== 'set_redis_key') {
          this.redisKey = '';
          this.redisDetail = [];
        }
        await this.run(archive, 'redis_info', {}, true);
        await this.run(archive, 'list_redis_keys', { redisDb: this.redisDb, name: this.query }, true);
        if (op === 'set_redis_key' && this.redisKey) {
          await this.run(archive, 'get_redis_key', { redisDb: this.redisDb, name: this.redisKey }, true);
        }
      }
      if (op === 'create_user' || op === 'drop_user' || op === 'grant' || op === 'revoke' || op === 'reset_password') {
        await this.run(archive, 'list_users', {}, true);
      }
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : t('feedback.danger'), { variant: 'danger' });
      return false;
    }
  }
}

function tabButton(section: 'databases' | 'accounts', key: 'db.databases' | 'db.users', id: string, active: boolean): HTMLButtonElement {
  const node = element('button', `server-group-item${active ? ' server-group-item-active' : ''}`, t(key)) as HTMLButtonElement;
  node.type = 'button';
  node.id = id;
  node.dataset.dbAction = 'section';
  node.dataset.dbSection = section;
  return node;
}

function databaseRow(name: string, redis: boolean): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.append(textCell(name), statusCell(t('db.statusRunning')), actionCell([
    redis ? actionLink(t('db.flush'), 'flush-database', name) : actionLink(t('common.delete'), 'drop-database', name),
  ]));
  return row;
}

function accountRow(name: string): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.append(textCell(name), actionCell([
    actionLink(t('db.resetPassword'), 'reset-password', name),
    actionLink(t('db.editPrivilege'), 'edit-priv', name),
    actionLink(t('common.delete'), 'drop-user', name),
  ], true));
  return row;
}

function textCell(value: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = value;
  return cell;
}

function statusCell(label: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  const wrap = element('span', 'inline-flex items-center gap-1.5');
  wrap.append(element('span', 'credential-type-dot'), document.createTextNode(label));
  cell.append(wrap);
  return cell;
}

function actionCell(actions: HTMLElement[], alignEnd = false): HTMLTableCellElement {
  const cell = document.createElement('td');
  if (alignEnd) {
    cell.className = 'text-right';
    cell.style.paddingRight = '28px';
  }
  const wrap = element('div', alignEnd ? 'flex flex-wrap gap-4 justify-end' : 'flex flex-wrap gap-3');
  wrap.append(...actions);
  cell.append(wrap);
  return cell;
}

function actionLink(label: string, action: string, value: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'text-primary text-[13px]';
  node.textContent = label;
  node.dataset.dbAction = action;
  node.dataset.dbValue = value;
  return node;
}

function labeled(key: 'db.colName' | 'db.colAccount' | 'db.userPassword' | 'db.databaseName' | 'db.redisKeyName' | 'db.redisKeyValue' | 'db.charset', control: HTMLElement): HTMLElement {
  const wrap = element('div', 'space-y-2');
  wrap.append(element('label', 'block text-xs font-bold tracking-[0.1em] text-muted', t(key)), control);
  return wrap;
}

function taskButton(label: string, action: () => void): HTMLButtonElement {
  const node = element('button', 'cyber-button text-primary px-4 py-2 text-xs font-bold', label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', () => action());
  return node;
}

function ensureTaskModal(): HTMLElement {
  const existing = document.getElementById('db-task-modal');
  if (existing) return existing;
  const modal = document.createElement('div');
  modal.id = 'db-task-modal';
  modal.className = 'responsive-modal hidden fixed inset-0 z-[100] flex items-center justify-center';
  modal.innerHTML = `
    <div class="modal-overlay absolute inset-0" id="db-task-backdrop"></div>
    <div class="responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-md mx-4">
      <div class="flex items-center justify-between mb-6 pb-4 border-b border-dim">
        <span id="db-task-title" class="text-sm font-bold tracking-[0.04em]"></span>
        <button type="button" id="db-task-close" class="panel-close-btn" aria-label="close">×</button>
      </div>
      <div id="db-task-body"></div>
    </div>`;
  modal.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'db-task-backdrop' || target.closest('#db-task-close')) modal.classList.add('hidden');
  });
  document.body.append(modal);
  return modal;
}

function checked(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input:checked')).map((node) => node.value);
}

function input(type: string, value: string): HTMLInputElement {
  const node = document.createElement('input');
  node.type = type;
  node.value = value;
  node.className = 'terminal-input text-[13px] w-full';
  return node;
}

function element(tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setValue(id: string, value: string): void {
  const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (node) node.value = value;
}

function valueOf(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

interface RedisKeyspace {
  db: string;
  index: number;
  keys: string;
  expires: string;
  avgTtl: string;
}

function redisKeyspace(lines: string[]): RedisKeyspace[] {
  return lines.filter((line) => line.startsWith('keyspace\t')).map((line) => {
    const [, db, keys, expires, avgTtl] = line.split('\t');
    return { db: db || 'db0', index: Number((db || 'db0').replace(/\D/g, '')) || 0, keys: keys || '0', expires: expires || '0', avgTtl: avgTtl || '0' };
  });
}

function redisInfoMap(lines: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of lines) {
    if (!line.startsWith('info\t')) continue;
    const parts = line.split('\t');
    if (parts[2]) map[parts[2]] = parts.slice(3).join('\t');
  }
  return map;
}

function redisStatCard(title: string, rows: Array<[string, string | undefined]>): HTMLElement {
  const card = element('section', 'rounded border border-[var(--border)] p-3');
  card.append(element('h4', 'text-xs font-bold mb-3', title));
  for (const [label, raw] of rows) {
    const row = element('div', 'flex items-center justify-between gap-3 text-[13px] py-1.5 border-t border-[var(--border)]');
    row.append(element('span', 'text-muted shrink-0', label), element('span', 'text-right break-all', raw || '—'));
    card.append(row);
  }
  return card;
}

function redisPairTable(lines: string[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'credential-table w-full text-left text-[13px]';
  table.innerHTML = `<thead><tr><th>${escapeHtml(t('db.redisField'))}</th><th>${escapeHtml(t('db.redisValue'))}</th></tr></thead>`;
  const body = document.createElement('tbody');
  for (const line of lines) {
    const split = line.indexOf('\t');
    const row = document.createElement('tr');
    row.append(textCell(split >= 0 ? line.slice(0, split) : line), textCell(split >= 0 ? line.slice(split + 1) : ''));
    body.append(row);
  }
  table.append(body);
  return table;
}
