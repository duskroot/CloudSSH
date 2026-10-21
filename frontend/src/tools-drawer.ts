import { copyTextToClipboard } from './clipboard';
import { attachDrawerSwipeToClose } from './drawer-swipe';
import { onLocaleChange, t } from './i18n';
import { notify } from './ui-feedback';

type ToolTab = 'password' | 'uuid' | 'keypair' | 'json';

const PANEL_ID = 'tools-panel';
const BACKDROP_ID = 'tools-panel-backdrop';

export class ToolsDrawer {
  private panel: HTMLElement | null = null;
  private backdrop: HTMLElement | null = null;
  private visible = false;
  private tab: ToolTab = 'password';
  private localeCleanup: (() => void) | null = null;

  constructor(private readonly onStateChange?: () => void) {
    this.localeCleanup = onLocaleChange(() => {
      if (this.visible) this.render();
    });
  }

  isOpen(): boolean {
    return this.visible;
  }

  open(): void {
    this.ensure();
    if (!this.panel || !this.backdrop) return;
    this.visible = true;
    this.backdrop.classList.remove('opacity-0', 'pointer-events-none');
    this.panel.style.transform = 'translateX(0)';
    this.onStateChange?.();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.backdrop?.classList.add('opacity-0', 'pointer-events-none');
    if (this.panel) this.panel.style.transform = 'translateX(100%)';
    this.onStateChange?.();
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  dispose(): void {
    this.localeCleanup?.();
    this.localeCleanup = null;
    this.panel?.remove();
    this.backdrop?.remove();
    this.panel = null;
    this.backdrop = null;
    this.visible = false;
  }

  private ensure(): void {
    if (this.panel && this.backdrop) return;
    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.className = 'fixed inset-0 bg-black/40 z-[95] transition-opacity duration-300 opacity-0 pointer-events-none';
    backdrop.addEventListener('click', () => this.close());
    this.backdrop = backdrop;
    document.body.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'fixed top-0 right-0 h-full z-[96] flex flex-col bg-surface border-l border-outline-variant shadow-2xl transition-transform duration-300 ease-in-out text-on-surface';
    panel.style.transform = 'translateX(100%)';
    this.panel = panel;
    attachDrawerSwipeToClose(panel, {
      headerSelector: '.sftp-panel-header',
      onClose: () => this.close(),
    });
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });
    document.body.appendChild(panel);
    this.render();
  }

  private render(): void {
    if (!this.panel) return;
    this.panel.replaceChildren(this.header(), this.tabs(), this.body());
  }

  private header(): HTMLElement {
    const header = el('div', 'sftp-panel-header flex items-center justify-between px-4 h-12 border-b border-outline-variant bg-elevated shrink-0');
    const title = el('span', 'text-xs font-bold tracking-[0.1em] text-primary-container', t('tools.title'));
    const close = el('button', 'panel-close-btn') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', t('common.close'));
    close.append(icon('close'));
    close.addEventListener('click', () => this.close());
    header.append(title, close);
    return header;
  }

  private tabs(): HTMLElement {
    const bar = el('div', 'server-form-tabs px-4');
    bar.setAttribute('role', 'tablist');
    const items: Array<[ToolTab, string]> = [
      ['password', t('tools.password')],
      ['uuid', t('tools.uuid')],
      ['keypair', t('tools.keypair')],
      ['json', t('tools.json')],
    ];
    for (const [id, label] of items) {
      const button = el('button', `server-form-tab${this.tab === id ? ' server-form-tab-active' : ''}`, label) as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => {
        this.tab = id;
        this.render();
      });
      bar.append(button);
    }
    return bar;
  }

  private body(): HTMLElement {
    const body = el('div', 'flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar min-h-0');
    if (this.tab === 'password') body.append(this.passwordPane());
    else if (this.tab === 'uuid') body.append(this.uuidPane());
    else if (this.tab === 'keypair') body.append(this.keypairPane());
    else body.append(this.jsonPane());
    return body;
  }

  private passwordPane(): HTMLElement {
    const wrap = el('div', 'space-y-3');
    const length = document.createElement('input');
    length.type = 'number';
    length.min = '8';
    length.max = '64';
    length.value = '16';
    length.className = 'terminal-input text-[13px] w-24';
    const lengthRow = el('label', 'flex items-center gap-3 text-xs text-muted');
    lengthRow.append(document.createTextNode(t('tools.length')), length);
    const checks = optionChecks([
      ['upper', t('tools.upper'), true],
      ['lower', t('tools.lower'), true],
      ['digit', t('tools.digits'), true],
      ['symbol', t('tools.symbols'), false],
    ]);
    const output = textOutput();
    const generate = primaryButton(t('tools.generate'), () => {
      const sets = selectedSets(checks);
      if (sets.length === 0) {
        notify(t('tools.charsetRequired'), { variant: 'warning' });
        return;
      }
      const size = clamp(Number(length.value) || 16, 8, 64);
      length.value = String(size);
      output.value = randomPassword(size, sets);
    });
    wrap.append(lengthRow, checks, generate, copyRow(output));
    return wrap;
  }

  private uuidPane(): HTMLElement {
    const wrap = el('div', 'space-y-3');
    const output = textOutput();
    output.value = crypto.randomUUID();
    const generate = primaryButton(t('tools.generate'), () => {
      output.value = crypto.randomUUID();
    });
    wrap.append(generate, copyRow(output));
    return wrap;
  }

  private keypairPane(): HTMLElement {
    const wrap = el('div', 'space-y-3');
    const hint = el('p', 'text-xs text-muted', t('tools.keypairHint'));
    const publicOut = areaOutput(t('tools.publicKey'));
    const privateOut = areaOutput(t('tools.privateKey'));
    const generate = primaryButton(t('tools.generate'), () => {
      generate.disabled = true;
      void generateKeyPair().then((pair) => {
        generate.disabled = false;
        if (!pair) {
          notify(t('tools.keypairFailed'), { variant: 'danger' });
          return;
        }
        publicOut.value = pair.publicKey;
        privateOut.value = pair.privateKey;
      });
    });
    wrap.append(hint, generate, labeled(t('tools.publicKey'), publicOut), labeled(t('tools.privateKey'), privateOut));
    return wrap;
  }

  private jsonPane(): HTMLElement {
    const wrap = el('div', 'space-y-3');
    const input = document.createElement('textarea');
    input.className = 'terminal-input text-[12px] w-full';
    input.rows = 12;
    input.placeholder = t('tools.jsonPlaceholder');
    const error = el('p', 'hidden text-xs text-error');
    const format = (space: number | undefined) => {
      try {
        input.value = JSON.stringify(JSON.parse(input.value), null, space);
        error.classList.add('hidden');
      } catch {
        error.textContent = t('tools.jsonInvalid');
        error.classList.remove('hidden');
      }
    };
    const row = el('div', 'flex gap-2');
    row.append(
      primaryButton(t('tools.jsonFormat'), () => format(2)),
      primaryButton(t('tools.jsonMinify'), () => format(undefined))
    );
    wrap.append(input, row, error);
    return wrap;
  }
}

function randomPassword(length: number, sets: string[]): string {
  const alphabet = sets.join('');
  const chars: string[] = [];
  for (const set of sets) chars.push(pick(set));
  while (chars.length < length) chars.push(pick(alphabet));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)];
}

function randomIndex(limit: number): number {
  const max = Math.floor(0x100000000 / limit) * limit;
  const sample = new Uint32Array(1);
  let value = max;
  while (value >= max) {
    crypto.getRandomValues(sample);
    value = sample[0];
  }
  return value % limit;
}

function selectedSets(root: HTMLElement): string[] {
  const sets: string[] = [];
  root.querySelectorAll<HTMLInputElement>('input[data-set]').forEach((input) => {
    if (!input.checked) return;
    if (input.dataset.set === 'upper') sets.push('ABCDEFGHJKLMNPQRSTUVWXYZ');
    if (input.dataset.set === 'lower') sets.push('abcdefghijkmnopqrstuvwxyz');
    if (input.dataset.set === 'digit') sets.push('23456789');
    if (input.dataset.set === 'symbol') sets.push('!@#$%^&*-_=+');
  });
  return sets;
}

async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string } | null> {
  const ed = await generateEd25519();
  if (ed) return ed;
  try {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    return {
      publicKey: pem('PUBLIC KEY', pub),
      privateKey: pem('PRIVATE KEY', priv),
    };
  } catch {
    return null;
  }
}

async function generateEd25519(): Promise<{ publicKey: string; privateKey: string } | null> {
  try {
    const pair = (await crypto.subtle.generateKey(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const seed = pkcs8.slice(-32);
    let pub: Uint8Array;
    try {
      pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    } catch {
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      pub = spki.slice(-32);
    }
    if (seed.length !== 32 || pub.length !== 32) return null;
    const pubBlob = concat(sshString('ssh-ed25519'), sshString(pub));
    const check = crypto.getRandomValues(new Uint32Array(1))[0];
    let secret = concat(
      u32(check),
      u32(check),
      sshString('ssh-ed25519'),
      sshString(pub),
      sshString(concat(seed, pub)),
      sshString('')
    );
    const pad = (8 - (secret.length % 8)) % 8;
    if (pad) {
      const padding = new Uint8Array(pad);
      for (let i = 0; i < pad; i++) padding[i] = i + 1;
      secret = concat(secret, padding);
    }
    const body = concat(
      new TextEncoder().encode('openssh-key-v1\0'),
      sshString('none'),
      sshString('none'),
      sshString(new Uint8Array()),
      u32(1),
      sshString(pubBlob),
      sshString(secret)
    );
    return {
      publicKey: `ssh-ed25519 ${b64(pubBlob)}`,
      privateKey: pem('OPENSSH PRIVATE KEY', body),
    };
  } catch {
    return null;
  }
}

function pem(label: string, bytes: Uint8Array): string {
  const body = b64(bytes).match(/.{1,64}/g)?.join('\n') ?? b64(bytes);
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function sshString(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return concat(u32(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function optionChecks(items: Array<[string, string, boolean]>): HTMLElement {
  const box = el('div', 'grid grid-cols-2 gap-2 text-xs');
  for (const [id, label, checked] of items) {
    const row = el('label', 'flex items-center gap-2');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.set = id;
    input.className = 'accent-[var(--accent)]';
    row.append(input, document.createTextNode(label));
    box.append(row);
  }
  return box;
}

function textOutput(): HTMLInputElement {
  const input = document.createElement('input');
  input.readOnly = true;
  input.className = 'terminal-input text-[13px] w-full';
  return input;
}

function areaOutput(label: string): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.readOnly = true;
  area.rows = 6;
  area.className = 'terminal-input text-[11px] w-full';
  area.setAttribute('aria-label', label);
  return area;
}

function labeled(label: string, field: HTMLTextAreaElement): HTMLElement {
  const wrap = el('div', 'space-y-1');
  wrap.append(el('div', 'text-xs text-muted', label), field, copyButton(field));
  return wrap;
}

function copyRow(field: HTMLInputElement): HTMLElement {
  const row = el('div', 'space-y-2');
  row.append(field, copyButton(field));
  return row;
}

function copyButton(field: HTMLInputElement | HTMLTextAreaElement): HTMLButtonElement {
  return primaryButton(t('common.copy'), () => {
    if (!field.value) return;
    void copyTextToClipboard(field.value).then((ok) => {
      notify(ok ? t('tools.copied') : t('terminal.pasteFailed'), { variant: ok ? 'success' : 'danger' });
    });
  });
}

function primaryButton(label: string, action: () => void): HTMLButtonElement {
  const button = el('button', 'cyber-button text-primary px-3 py-2 text-xs font-bold', label) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLElement {
  const span = el('span', 'material-symbols-outlined', name);
  span.style.fontSize = '18px';
  return span;
}
