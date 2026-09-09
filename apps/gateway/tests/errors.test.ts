import { describe, expect, it } from 'vitest';
import { cliError, gatewayError } from '@llm-runtime-dock/core';
import type { GatewayError } from '@llm-runtime-dock/core';
import { isLoopbackAddress, toErrorResponse } from '../src/index.js';

/** The HTTP error surface (spec §14, §25, §28). */

describe('loopback classification', () => {
  it('recognises every loopback spelling', () => {
    for (const address of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
  });

  it('rejects anything reachable from elsewhere', () => {
    for (const address of ['0.0.0.0', '192.168.1.10', '10.0.0.1', '', undefined]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });
});

describe('OpenAI-style error responses', () => {
  it('maps each gateway code to a status and type', () => {
    const cases: Array<[GatewayError['code'], number, string]> = [
      ['MODEL_NOT_FOUND', 404, 'invalid_request_error'],
      ['ADAPTER_NOT_FOUND', 400, 'invalid_request_error'],
      ['RUNTIME_READY_TIMEOUT', 504, 'api_error'],
      ['RUNTIME_MODEL_PINNED', 409, 'api_error'],
      ['RUNTIME_SLOT_BUSY', 503, 'api_error'],
      ['UPSTREAM_UNAUTHORIZED', 401, 'authentication_error'],
      ['UPSTREAM_UNAVAILABLE', 502, 'api_error'],
      ['UPSTREAM_SURFACE_UNSUPPORTED', 400, 'invalid_request_error'],
    ];
    for (const [code, status, type] of cases) {
      const response = toErrorResponse(gatewayError(code, 'boom'));
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.body.error.type).toBe(type);
    }
  });

  it('folds the hint into the message and carries details', () => {
    const response = toErrorResponse(
      gatewayError('MODEL_NOT_FOUND', 'unknown model "x"', {
        hint: 'configured ids: a, b',
        details: { model: 'x' },
      }),
    );
    expect(response.body.error.message).toContain('unknown model "x"');
    expect(response.body.error.message).toContain('configured ids: a, b');
    expect(response.body.error.details).toEqual({ model: 'x' });
  });

  it('never turns a CLI-namespace error into an HTTP code', () => {
    // GATEWAY_NOT_RUNNING cannot be an HTTP answer by definition (§25), so a CLI
    // error falls through to a generic 500 rather than being mapped.
    const response = toErrorResponse(cliError('GATEWAY_NOT_RUNNING', 'not running'));
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
  });

  it('handles a non-Error throw', () => {
    const response = toErrorResponse('something odd');
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
  });
});
