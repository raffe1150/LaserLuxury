export type P2ExecutionMode =
  | "shadow"
  | "authority";

export class P2ExecutionBoundaryError extends Error {
  readonly code =
    "P2_EXECUTION_BOUNDARY_ERROR";

  constructor(
    message: string,
    readonly causeCode:
      | "authority_required"
      | "invalid_execution_mode",
  ) {
    super(message);
    this.name =
      "P2ExecutionBoundaryError";
  }
}

export function assertAuthorityExecution(
  mode: P2ExecutionMode,
): void {
  if (mode === "authority") {
    return;
  }

  if (mode === "shadow") {
    throw new P2ExecutionBoundaryError(
      "Shadow execution cannot enter the authoritative mutation path.",
      "authority_required",
    );
  }

  throw new P2ExecutionBoundaryError(
    "Unknown P2 execution mode.",
    "invalid_execution_mode",
  );
}
