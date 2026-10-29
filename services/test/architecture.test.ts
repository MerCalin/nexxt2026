import { expect, test } from "bun:test";
import { findViolations } from "../scripts/check-agent-imports";

test("agents never import each other or adapters", () => {
  expect(findViolations()).toEqual([]);
});
