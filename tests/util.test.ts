import { describe, expect, it } from "vitest";
import { canonicalJson, centsToValue, hashObject, valueToCents } from "@/lib/util";

describe("money", () => {
  it("formats cents as PayPal values", () => {
    expect(centsToValue(5184)).toBe("51.84");
    expect(centsToValue(5)).toBe("0.05");
    expect(centsToValue(6000)).toBe("60.00");
    expect(() => centsToValue(1.5)).toThrow();
  });
  it("parses PayPal values to cents without float drift", () => {
    expect(valueToCents("51.84")).toBe(5184);
    expect(valueToCents("0.1")).toBe(10);
    expect(valueToCents("74.39")).toBe(7439);
    expect(valueToCents(19.99)).toBe(1999);
    expect(() => valueToCents("1.234")).toThrow();
    expect(() => valueToCents("abc")).toThrow();
  });
});

describe("canonical json", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    expect(hashObject({ x: 1, y: 2 })).toBe(hashObject({ y: 2, x: 1 }));
    expect(hashObject({ x: 1 })).not.toBe(hashObject({ x: 2 }));
  });
});
