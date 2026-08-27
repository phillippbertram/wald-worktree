export class YggError extends Error {
  readonly exitCode: number;

  constructor(message: string, options?: { cause?: unknown; exitCode?: number }) {
    super(message, { cause: options?.cause });
    this.name = "YggError";
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
