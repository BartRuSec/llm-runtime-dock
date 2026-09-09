import { cliError } from '@llm-runtime-dock/core';
import type { CliError } from '@llm-runtime-dock/core';
import type { GatewayStatus } from '@llm-runtime-dock/core';

/**
 * HTTP client for a running gateway (spec §27).
 *
 * `status` and `switch` are what people run *because* something looks wrong, so
 * a refused connection must read as "gateway not running", never as a stack
 * trace. `GATEWAY_NOT_RUNNING` is a CLI-namespace code by definition: a gateway
 * that is not running cannot answer with an HTTP error.
 */

const notRunning = (endpoint: string, cause?: unknown): CliError => {
  return cliError('GATEWAY_NOT_RUNNING', `gateway not running at ${endpoint}`, {
    details: { endpoint },
    cause,
    hint: 'start it with `lrd serve`',
  });
};

const request = async (endpoint: string, path: string, init: RequestInit): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, init);
  } catch (cause) {
    throw notRunning(endpoint, cause);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      if (text.trim()) message = text.trim().slice(0, 300);
    }
    throw cliError(
      'GATEWAY_NOT_RUNNING',
      `gateway at ${endpoint} refused the request: ${message}`,
      {
        details: { endpoint, status: response.status },
      },
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw cliError('GATEWAY_NOT_RUNNING', `gateway at ${endpoint} returned a non-JSON response`, {
      details: { endpoint },
      cause,
    });
  }
};

export const fetchStatus = async (endpoint: string): Promise<GatewayStatus> => {
  return (await request(endpoint, '/status', { method: 'GET' })) as GatewayStatus;
};

export const requestSwitch = async (endpoint: string, model: string): Promise<GatewayStatus> => {
  return (await request(endpoint, '/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  })) as GatewayStatus;
};
