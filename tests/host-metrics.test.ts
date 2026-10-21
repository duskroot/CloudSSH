import { describe, expect, it } from 'vitest';
import { cpuPercent, parseHostMetrics } from '../frontend/src/host-metrics';

const sample = `cpu  100 0 50 850 0 0 0 0
cpu0 100 0 50 850 0 0 0 0
---MEM---
MemTotal:       1000000 kB
MemAvailable:    400000 kB
---DISK---
Filesystem     1024-blocks   Used Available Capacity Mounted on
/dev/sda1         1000000 250000    750000      25% /
`;

describe('host metrics parser', () => {
  it('computes cpu delta, memory, and root disk', () => {
    const first = parseHostMetrics(sample, null);
    expect(first.values.cpu).toBeNull();
    expect(first.values.memory).toBe(60);
    expect(first.values.disk).toBe(25);
    const next = sample.replace('cpu  100 0 50 850', 'cpu  200 0 100 900');
    const second = parseHostMetrics(next, first.cpu);
    expect(second.values.cpu).toBe(cpuPercent(first.cpu!, second.cpu!));
    expect(second.values.cpu).toBeGreaterThan(0);
  });
});
