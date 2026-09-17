import assert from "node:assert/strict";
import test from "node:test";

import {
  P2ExecutionBoundaryError,
  assertAuthorityExecution,
} from "./execution-boundary";

test("authority mode is permitted", () => {
  assert.doesNotThrow(() => {
    assertAuthorityExecution(
      "authority",
    );
  });
});

test("shadow mode is blocked from authoritative mutation path", () => {
  assert.throws(
    () => {
      assertAuthorityExecution(
        "shadow",
      );
    },
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2ExecutionBoundaryError,
      );

      assert.equal(
        error.causeCode,
        "authority_required",
      );

      return true;
    },
  );
});
