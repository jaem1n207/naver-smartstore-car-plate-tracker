import { redactSecrets } from "./redact.js";

export interface SafeErrorLog {
  readonly name: string;
  readonly message: string;
  readonly code: string | undefined;
  readonly status: number | undefined;
}

const SECRET_ENV_KEYS = [
  "STORE_A_CLIENT_ID",
  "STORE_A_CLIENT_SECRET",
  "STORE_A_ACCOUNT_ID",
  "STORE_B_CLIENT_ID",
  "STORE_B_CLIENT_SECRET",
  "STORE_B_ACCOUNT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
];

export function safeErrorLog(error: unknown, secrets: readonly string[]): SafeErrorLog {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecrets(error.message, secrets),
      code: errorCode(error),
      status: errorStatus(error),
    };
  }

  return {
    name: "UnknownError",
    message: redactSecrets(String(error), secrets),
    code: undefined,
    status: undefined,
  };
}

export function runtimeSecretValues(source: Record<string, string | undefined>): string[] {
  return SECRET_ENV_KEYS.map((key) => source[key] ?? "");
}

function errorCode(source: object): string | undefined {
  if (!("code" in source)) {
    return undefined;
  }

  const value = source.code;

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return undefined;
}

function errorStatus(source: object): number | undefined {
  if (!("status" in source)) {
    return undefined;
  }

  const value = source.status;

  if (typeof value === "number") {
    return value;
  }

  return undefined;
}
