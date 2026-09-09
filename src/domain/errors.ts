export class YggError extends Error {
  readonly exitCode: number;
  readonly effects: unknown;

  constructor(
    message: string,
    options?: { cause?: unknown; exitCode?: number; effects?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "YggError";
    this.exitCode = options?.exitCode ?? 1;
    this.effects = options?.effects;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
