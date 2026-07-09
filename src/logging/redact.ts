export function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("[REDACTED]"), message);
}
