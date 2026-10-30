// Preserve the shared OpenAI/Codex credential and provider-override filtering policy.
export const environmentWithoutApiKeys = (
  source: Record<string, string | undefined>
): Record<string, string> => {
  const forbidden = new Set([
    "CODEX_AUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "CODEX_ACCESS_TOKEN",
    "CODEX_BASE_URL",
    "CODEX_MODEL_PROVIDER",
    "CODEX_PROVIDER",
  ]);

  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) =>
      value !== undefined &&
      !forbidden.has(key) &&
      !["OPENAI_", "AZURE_OPENAI_", "CODEX_API_"].some((prefix) =>
        key.startsWith(prefix)
      )
        ? [[key, value]]
        : []
    )
  );
};
