export interface CpuSample {
  idle: number;
  total: number;
}

export interface HostMetricValues {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

export function parseCpuSample(text: string): CpuSample | null {
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return { idle, total };
}

export function cpuPercent(previous: CpuSample, next: CpuSample): number | null {
  const total = next.total - previous.total;
  const idle = next.idle - previous.idle;
  if (total <= 0) return null;
  return clampPercent((1 - idle / total) * 100);
}

export function parseMemoryPercent(text: string): number | null {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  const total = values.get('MemTotal');
  if (!total) return null;
  const available =
    values.get('MemAvailable') ??
    (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0);
  return clampPercent(((total - available) / total) * 100);
}

export function parseDiskPercent(text: string): number | null {
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Filesystem'));
  const root = rows.find((line) => /\s\/$/.test(line)) ?? rows.at(-1);
  if (!root) return null;
  const columns = root.split(/\s+/);
  const match = /^(\d+)%$/.exec(columns.at(-2) ?? '');
  return match ? clampPercent(Number(match[1])) : null;
}

export function parseHostMetrics(
  stdout: string,
  previousCpu: CpuSample | null
): { cpu: CpuSample | null; values: HostMetricValues } {
  const memSplit = stdout.split('---MEM---');
  const stat = memSplit[0] ?? '';
  const rest = memSplit[1] ?? '';
  const diskSplit = rest.split('---DISK---');
  const cpu = parseCpuSample(stat);
  return {
    cpu,
    values: {
      cpu: cpu && previousCpu ? cpuPercent(previousCpu, cpu) : null,
      memory: parseMemoryPercent(diskSplit[0] ?? ''),
      disk: parseDiskPercent(diskSplit[1] ?? ''),
    },
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
