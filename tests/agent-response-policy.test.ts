import { describe, expect, it } from 'vitest';
import { resolveAIModelBudgets } from '../src/ai-model-policy';
import { normalizeResponseDiagnostics } from '../src/agent-response-diagnostics';
import { responseErrorMessage } from '../frontend/src/agent/response-errors';
import { setLocale } from '../frontend/src/i18n';

const requestId = '12345678-1234-4123-8123-123456789abc';
describe('AI model budgets and safe diagnostics', () => {
  it('uses compatible defaults and accepts explicit model limits', () => {
    expect(resolveAIModelBudgets({})).toEqual({ context_window: 64_000, max_output_tokens: 8192 });
    expect(resolveAIModelBudgets({ context_window: null, max_output_tokens: null })).toEqual(resolveAIModelBudgets({}));
    expect(resolveAIModelBudgets({ context_window: 8192, max_output_tokens: 1024 })).toEqual({ context_window: 8192, max_output_tokens: 1024 });
  });
  it.each([
    { context_window: 4096 }, { context_window: '32000' }, { context_window: 1_000_001 },
    { max_output_tokens: 0 }, { max_output_tokens: 128_001 }, { max_output_tokens: 1.5 },
    { context_window: 8192, max_output_tokens: 8192 }, { max_output_tokens: false },
  ])('rejects invalid limits without coercing types: %j', value => {
    expect(() => resolveAIModelBudgets(value)).toThrow();
  });
  it('drops unknown metadata and all free-form provider text', () => {
    expect(normalizeResponseDiagnostics({ purpose: 'memory', stage: 'parse', requestId,
      parameter: 'input', providerCode: 'context_length_exceeded', message: 'SECRET', arbitrary: 'SECRET' }))
      .toEqual({ purpose: 'memory', stage: 'parse', requestId, parameter: 'input', providerCode: 'context_length_exceeded' });
    expect(normalizeResponseDiagnostics({ purpose: 'SECRET', stage: 'SECRET', requestId: 'SECRET',
      parameter: 'SECRET', providerCode: 'SECRET' })).toEqual({});
  });
  it.each(['zh-CN', 'zh-TW', 'en-US'] as const)('renders only allowlisted error details in %s', locale => {
    setLocale(locale, { persist: false });
    const message = responseErrorMessage('responses_http', 400, {
      purpose: 'checkpoint', stage: 'http', requestId, parameter: 'text.format',
      providerCode: 'unsupported_parameter', message: '<script>SECRET</script>',
    });
    expect(message).toContain('400');
    expect(message).toContain('text.format');
    expect(message).toContain(requestId);
    expect(message).not.toMatch(/SECRET|<script>|agent\.error/);
    expect(responseErrorMessage('SECRET', 'SECRET' as any, { requestId: 'SECRET' })).not.toContain('SECRET');
  });
});
