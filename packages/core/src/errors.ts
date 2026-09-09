/**
 * Typed errors in two namespaces that must never be mixed (spec §25).
 *
 * `GatewayErrorCode` values are mapped to OpenAI-style HTTP error responses.
 * `CliErrorCode` values are configuration- and command-time failures. They exit
 * non-zero with a readable message and are deliberately absent from the HTTP
 * response mapper: a gateway that is not running cannot answer with an error.
 */

export const GATEWAY_ERROR_CODES = [
  'MODEL_NOT_FOUND',
  'ADAPTER_NOT_FOUND',
  'RUNTIME_START_FAILED',
  'RUNTIME_READY_TIMEOUT',
  'RUNTIME_MODEL_MISMATCH',
  'RUNTIME_STOP_FAILED',
  'RUNTIME_SLOT_BUSY',
  'RUNTIME_MODEL_PINNED',
  'RUNTIME_UNLOAD_FAILED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_UNAUTHORIZED',
  'UPSTREAM_SURFACE_UNSUPPORTED',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export const CLI_ERROR_CODES = [
  'CONFIG_INVALID',
  'RUNTIME_OPTIONS_INVALID',
  'RUNTIME_OPTION_RESERVED',
  'DISCOVERY_NAME_CONFLICT',
  'DISCOVERY_INVALID_MODEL_ID',
  'DISCOVERY_AUTH_REQUIRED',
  'GATEWAY_NOT_RUNNING',
  'AGENT_NOT_INSTALLED',
  'AGENT_SURFACE_UNSUPPORTED',
  'AGENT_SECRET_UNSUPPORTED',
  'AGENT_CONFIG_UNREADABLE',
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export interface ErrorDetails {
  readonly [key: string]: string | number | boolean | string[] | undefined;
}

export interface DockErrorOptions {
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
  /** Suggested remediation, printed by the CLI and included in HTTP errors. */
  readonly hint?: string;
}

/**
 * Both error shapes are plain `Error` objects carrying a `namespace` tag, built
 * by a factory rather than by a subclass. The tag is what the type guards read,
 * so the two namespaces stay distinguishable without `instanceof` — and without
 * the prototype fragility that subclassing `Error` brings across realms.
 */

/** A failure the gateway can answer with over HTTP. */
export interface GatewayError extends Error {
  readonly namespace: 'gateway';
  readonly code: GatewayErrorCode;
  readonly details: ErrorDetails;
  readonly hint: string | undefined;
}

/** A configuration- or command-time failure. Never becomes an HTTP response. */
export interface CliError extends Error {
  readonly namespace: 'cli';
  readonly code: CliErrorCode;
  readonly details: ErrorDetails;
  readonly hint: string | undefined;
}

const causeOf = (options: DockErrorOptions): ErrorOptions | undefined =>
  options.cause === undefined ? undefined : { cause: options.cause };

export const gatewayError = (
  code: GatewayErrorCode,
  message: string,
  options: DockErrorOptions = {},
): GatewayError =>
  Object.assign(new Error(message, causeOf(options)), {
    name: 'GatewayError',
    namespace: 'gateway' as const,
    code,
    details: options.details ?? {},
    hint: options.hint,
  });

export const cliError = (
  code: CliErrorCode,
  message: string,
  options: DockErrorOptions = {},
): CliError =>
  Object.assign(new Error(message, causeOf(options)), {
    name: 'CliError',
    namespace: 'cli' as const,
    code,
    details: options.details ?? {},
    hint: options.hint,
  });

export const isGatewayError = (value: unknown): value is GatewayError =>
  value instanceof Error && (value as Partial<GatewayError>).namespace === 'gateway';

export const isCliError = (value: unknown): value is CliError =>
  value instanceof Error && (value as Partial<CliError>).namespace === 'cli';

/** HTTP status for each gateway error code. */
const GATEWAY_ERROR_STATUS: Record<GatewayErrorCode, number> = {
  MODEL_NOT_FOUND: 404,
  ADAPTER_NOT_FOUND: 400,
  RUNTIME_START_FAILED: 502,
  RUNTIME_READY_TIMEOUT: 504,
  RUNTIME_MODEL_MISMATCH: 502,
  RUNTIME_STOP_FAILED: 500,
  RUNTIME_SLOT_BUSY: 503,
  RUNTIME_MODEL_PINNED: 409,
  RUNTIME_UNLOAD_FAILED: 500,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_UNAUTHORIZED: 401,
  UPSTREAM_SURFACE_UNSUPPORTED: 400,
};

/** OpenAI-style `error.type` for each gateway error code. */
const GATEWAY_ERROR_TYPE: Record<GatewayErrorCode, string> = {
  MODEL_NOT_FOUND: 'invalid_request_error',
  ADAPTER_NOT_FOUND: 'invalid_request_error',
  RUNTIME_START_FAILED: 'api_error',
  RUNTIME_READY_TIMEOUT: 'api_error',
  RUNTIME_MODEL_MISMATCH: 'api_error',
  RUNTIME_STOP_FAILED: 'api_error',
  RUNTIME_SLOT_BUSY: 'api_error',
  RUNTIME_MODEL_PINNED: 'api_error',
  RUNTIME_UNLOAD_FAILED: 'api_error',
  UPSTREAM_UNAVAILABLE: 'api_error',
  UPSTREAM_UNAUTHORIZED: 'authentication_error',
  UPSTREAM_SURFACE_UNSUPPORTED: 'invalid_request_error',
};

export const gatewayErrorStatus = (code: GatewayErrorCode): number => GATEWAY_ERROR_STATUS[code];

export const gatewayErrorType = (code: GatewayErrorCode): string => GATEWAY_ERROR_TYPE[code];
