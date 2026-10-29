import { describe, expect, it } from "vitest";
import { slugify } from "./orgs";

describe("slugify", () => {
  it.each([
    ["Acme Inc.", "acme-inc"],
    ["  Crème Brûlée Co ", "creme-brulee-co"],
    ["___", "org"],
    ["a".repeat(80), "a".repeat(40)],
  ])("%s -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
