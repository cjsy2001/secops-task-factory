/** A refusal the caller can act on. `code` is stable; `message` says what to do instead. */
export class StfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StfError";
  }
}
