export type MobileModifier = 'ctrl' | 'alt' | 'shift';
export type MobileTerminalKey =
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'delete'
  | 'insert'
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_right'
  | 'arrow_left'
  | 'home'
  | 'end'
  | 'page_up'
  | 'page_down'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'
  | 'ctrl_c'
  | 'ctrl_d'
  | 'ctrl_z'
  | 'ctrl_l';

const MOBILE_TERMINAL_KEYS = new Set<MobileTerminalKey>([
  'escape',
  'tab',
  'backtab',
  'delete',
  'insert',
  'arrow_up',
  'arrow_down',
  'arrow_right',
  'arrow_left',
  'home',
  'end',
  'page_up',
  'page_down',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
  'ctrl_c',
  'ctrl_d',
  'ctrl_z',
  'ctrl_l',
]);

export function isMobileTerminalKey(key: string): key is MobileTerminalKey {
  return MOBILE_TERMINAL_KEYS.has(key as MobileTerminalKey);
}

/**
 * 计算 xterm 隐藏 textarea 在一次延迟输入前后的差异。
 * iOS 中文输入法会在 keyup 前才把标点或空格写入 textarea。
 */
export function diffTextareaInput(oldValue: string, newValue: string): string {
  if (oldValue === newValue) return '';

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < oldValue.length &&
    commonPrefixLength < newValue.length &&
    oldValue.charCodeAt(commonPrefixLength) === newValue.charCodeAt(commonPrefixLength)
  ) {
    commonPrefixLength++;
  }

  const removedCount = oldValue.length - commonPrefixLength;
  return `${'\x7f'.repeat(removedCount)}${newValue.substring(commonPrefixLength)}`;
}

/** 精确识别 xterm 的焦点报告，不能将方向键、Alt 或粘贴等 ESC 序列一并视为报告。 */
export function isTerminalFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}

/** 将移动端一次性 Ctrl/Alt/Shift 状态应用到下一段终端输入。 */
export function applyMobileModifier(
  data: string,
  modifier: MobileModifier | null
): { data: string; consumed: boolean } {
  if (!modifier || !data) return { data, consumed: false };

  if (modifier === 'alt') {
    return { data: `\x1b${data}`, consumed: true };
  }

  if (modifier === 'shift') {
    if (data === '\t') return { data: '\x1b[Z', consumed: true };
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code >= 97 && code <= 122) {
        return { data: data.toUpperCase(), consumed: true };
      }
      const shiftMap: Record<string, string> = {
        '1': '!',
        '2': '@',
        '3': '#',
        '4': '$',
        '5': '%',
        '6': '^',
        '7': '&',
        '8': '*',
        '9': '(',
        '0': ')',
        '-': '_',
        '=': '+',
        '[': '{',
        ']': '}',
        '\\': '|',
        ';': ':',
        "'": '"',
        ',': '<',
        '.': '>',
        '/': '?',
        '`': '~',
      };
      if (shiftMap[data]) {
        return { data: shiftMap[data], consumed: true };
      }
    }
    return { data, consumed: true };
  }

  if (data.length !== 1) return { data, consumed: true };
  if (data === ' ') return { data: '\x00', consumed: true };
  const originalCode = data.charCodeAt(0);
  const code = originalCode >= 97 && originalCode <= 122 ? originalCode - 32 : originalCode;
  if (code >= 64 && code <= 95) {
    return { data: String.fromCharCode(code & 0x1f), consumed: true };
  }
  if (data === '?') return { data: '\x7f', consumed: true };
  return { data, consumed: true };
}

/** 按照 xterm 的 application cursor mode 和修饰键生成终端按键序列。 */
export function mobileTerminalKeySequence(
  key: MobileTerminalKey,
  applicationCursorMode: boolean,
  modifier: MobileModifier | null
): string {
  const modifierCode =
    modifier === 'ctrl' ? 5 : modifier === 'alt' ? 3 : modifier === 'shift' ? 2 : null;

  if (key === 'escape') return modifier === 'alt' ? '\x1b\x1b' : '\x1b';
  if (key === 'tab') return modifier === 'shift' ? '\x1b[Z' : '\t';
  if (key === 'backtab') return '\x1b[Z';
  if (key === 'ctrl_c') return '\x03';
  if (key === 'ctrl_d') return '\x04';
  if (key === 'ctrl_z') return '\x1a';
  if (key === 'ctrl_l') return '\x0c';

  const tildeCode: Partial<Record<MobileTerminalKey, string>> = {
    insert: '2',
    delete: '3',
    page_up: '5',
    page_down: '6',
    f5: '15',
    f6: '17',
    f7: '18',
    f8: '19',
    f9: '20',
    f10: '21',
    f11: '23',
    f12: '24',
  };
  const number = tildeCode[key];
  if (number) {
    return modifierCode ? `\x1b[${number};${modifierCode}~` : `\x1b[${number}~`;
  }

  const fn1To4Final: Partial<Record<MobileTerminalKey, string>> = {
    f1: 'P',
    f2: 'Q',
    f3: 'R',
    f4: 'S',
  };
  const fnFinal = fn1To4Final[key];
  if (fnFinal) {
    return modifierCode ? `\x1b[1;${modifierCode}${fnFinal}` : `\x1bO${fnFinal}`;
  }

  const cursorFinal: Partial<Record<MobileTerminalKey, string>> = {
    arrow_up: 'A',
    arrow_down: 'B',
    arrow_right: 'C',
    arrow_left: 'D',
    home: 'H',
    end: 'F',
  };
  const final = cursorFinal[key];
  if (!final) return '';
  if (modifierCode) {
    return `\x1b[1;${modifierCode}${final}`;
  }
  return applicationCursorMode ? `\x1bO${final}` : `\x1b[${final}`;
}

export function isIOSLike(
  navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>
): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigatorLike.userAgent) ||
    (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1)
  );
}
