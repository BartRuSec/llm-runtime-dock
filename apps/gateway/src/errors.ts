import type { GatewayErrorCode } from '@llm-runtime-dock/core';
import { gatewayErrorStatus, gatewayErrorType, isGatewayError } from '@llm-runtime-dock/core';

/**
 * OpenAI-style error responses (spec §14, §25).
 *
 * Only the gateway namespace is wired in here. CLI codes such as
 * `GATEWAY_NOT_RUNNING` are configuration- and command-time failures and by
 * definition cannot be HTTP responses.
 */

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: GatewayErrorCode | 'internal_error';
    param: null;
    details?: Record<string, unknown>;
  };
}

export const toErrorResponse = (error: unknown): { status: number; body: ErrorBody } => {
  if (isGatewayError(error)) {
    return {
      status: gatewayErrorStatus(error.code),
      body: {
        error: {
          message: error.hint ? `${error.message} — ${error.hint}` : error.message,
          type: gatewayErrorType(error.code),
          code: error.code,
          param: null,
          details: Object.keys(error.details).length > 0 ? { ...error.details } : undefined,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        message: error instanceof Error ? error.message : 'internal error',
        type: 'api_error',
        code: 'internal_error',
        param: null,
      },
    },
  };
};
