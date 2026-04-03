let installed = false;

export function installLibraryLogFilters(): void {
  if (installed) {
    return;
  }

  const originalInfo = console.info.bind(console);

  console.info = ((...args: unknown[]) => {
    if (shouldSuppressInfo(args)) {
      return;
    }

    originalInfo(...args);
  }) as typeof console.info;

  installed = true;
}

function shouldSuppressInfo(args: unknown[]): boolean {
  return args[0] === 'Migrating session to:';
}
