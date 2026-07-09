import bcrypt from "bcryptjs";

export interface SignatureInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timestamp: number;
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export function createClientSecretSign(input: SignatureInput): string {
  const password = `${input.clientId}_${String(input.timestamp)}`;
  const hashed = bcrypt.hashSync(password, input.clientSecret);
  return Buffer.from(hashed, "utf8").toString("base64");
}

export class TokenCache {
  private readonly tokens = new Map<string, { accessToken: string; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get(storeKey: string): string | undefined {
    const cached = this.tokens.get(storeKey);

    if (!cached || cached.expiresAtMs <= this.nowMs()) {
      return undefined;
    }

    return cached.accessToken;
  }

  set(storeKey: string, response: TokenResponse): void {
    const safetyWindowSeconds = 60;
    const usableSeconds = Math.max(0, response.expiresIn - safetyWindowSeconds);

    this.tokens.set(storeKey, {
      accessToken: response.accessToken,
      expiresAtMs: this.nowMs() + usableSeconds * 1000,
    });
  }

  clear(storeKey: string): void {
    this.tokens.delete(storeKey);
  }
}
