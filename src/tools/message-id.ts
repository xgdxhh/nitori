export function resolveMessageId(
  provided: string | undefined,
  fallback: string | undefined,
  fieldName: string,
  errorContext: string,
): string {
  const candidate = provided?.trim() || fallback?.trim();
  if (!candidate) {
    throw new Error(`${fieldName} is required for ${errorContext}`);
  }
  return candidate;
}
