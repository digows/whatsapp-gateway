export function renderConfigTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, placeholderName: string) => {
    const value = values[placeholderName];
    if (value === undefined || value === null) {
      throw new Error(
        `Missing config template placeholder "${placeholderName}" for template "${template}"`,
      );
    }

    return String(value);
  });
}
