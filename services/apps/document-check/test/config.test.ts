import { expect, test } from "bun:test";
import { checkRegion, NON_EU_DEMO_OVERRIDE } from "../src/config";

test("EU regions need no override", () => {
  expect(checkRegion("eu-central-1", {})).toEqual({ allowNonEu: false });
});

test("non-EU regions need the exact demo override and are refused in production", () => {
  expect(() => checkRegion("us-east-1", {})).toThrow("EU region");
  expect(() => checkRegion("us-east-1", { ALLOW_NON_EU_REGION: "yes" })).toThrow("EU region");
  expect(checkRegion("us-east-1", { ALLOW_NON_EU_REGION: NON_EU_DEMO_OVERRIDE })).toEqual({ allowNonEu: true });
  expect(() => checkRegion("us-east-1", { ALLOW_NON_EU_REGION: NON_EU_DEMO_OVERRIDE, NODE_ENV: "production" })).toThrow("production");
});
