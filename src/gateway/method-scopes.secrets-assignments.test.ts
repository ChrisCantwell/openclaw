import { describe, expect, it } from "vitest";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";

describe("agent secret assignment method scopes", () => {
  for (const method of [
    "secrets.assignments.list",
    "secrets.assignments.has",
    "secrets.assignments.entry",
    "secrets.assignments.admin.list",
    "secrets.assignments.admin.assign",
    "secrets.assignments.admin.unassign",
    "secrets.assignments.enforcement.get",
    "secrets.assignments.enforcement.set",
  ]) {
    it(`requires operator.admin for ${method}`, () => {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method, {})).toEqual(["operator.admin"]);
    });
  }
});
