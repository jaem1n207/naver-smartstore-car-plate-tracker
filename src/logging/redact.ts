export function redactSecrets(message: string, secrets: readonly string[]): string {
  const normalizedSecrets = Array.from(
    new Set(secrets.map((secret) => secret.trim()).filter((secret) => secret.length > 0)),
  ).sort((left, right) => right.length - left.length);

  return normalizedSecrets.reduce(
    (current, secret) => current.split(secret).join("[REDACTED]"),
    message,
  );
}
