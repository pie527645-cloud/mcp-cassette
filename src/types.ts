export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonValue;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: JsonValue;
  error?: JsonRpcErrorObject;
}

export type InteractionKind = 'request' | 'client_notification' | 'server_notification';

export interface RecordedResponse {
  result?: JsonValue;
  error?: JsonRpcErrorObject;
}

export interface CassetteInteraction {
  index: number;
  kind: InteractionKind;
  method: string;
  requestId?: JsonRpcId;
  params?: JsonValue;
  response?: RecordedResponse;
  latencyMs: number;
}

export interface CassetteServerInfo {
  name: string;
  version: string;
  [key: string]: JsonValue;
}

export interface CassetteV1 {
  version: 1;
  recordedAt: string;
  serverCommand: string[];
  protocolVersion: string | null;
  serverInfo: CassetteServerInfo | null;
  redactionCount: number;
  interactions: CassetteInteraction[];
}

export interface RedactorOptions {
  redactEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  extraSecrets?: string[];
}

export interface RedactionResult<T> {
  value: T;
  redactionCount: number;
  uniqueSecretsCount: number;
}

export interface RecordOptions {
  stdioCommand: string | string[];
  outPath?: string;
  redactEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
  stderrStream?: NodeJS.WritableStream;
  recordedAt?: string;
}

export interface RecordSessionResult {
  cassette: CassetteV1;
  timedOut: boolean;
  exitCode: number | null;
}

export interface ReplayOptions {
  cassette: CassetteV1 | string;
  strict?: boolean;
  latencyMs?: number;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
}

export type InspectFormat = 'pretty' | 'json' | 'markdown';

export interface CassetteInspection {
  cassettePath?: string;
  version: number;
  recordedAt: string;
  serverCommand: string[];
  protocolVersion: string | null;
  serverInfo: CassetteServerInfo | null;
  interactionCount: number;
  requestCount: number;
  clientNotificationCount: number;
  serverNotificationCount: number;
  uniqueMethods: string[];
  uniqueToolNames: string[];
  payloadBytes: {
    requestBytes: number;
    responseBytes: number;
    totalBytes: number;
    cassetteBytes?: number;
  };
  estimatedTokens: number;
  latencyMs: {
    p50: number;
    p95: number;
    min: number;
    max: number;
    total: number;
  };
  redactionCount: number;
  uniquePlaceholders: number;
}
