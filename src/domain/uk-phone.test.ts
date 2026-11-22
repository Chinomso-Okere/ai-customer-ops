import { describe, expect, it } from "vitest";
import { normaliseCallbackPhone, normaliseUkPhone } from "./uk-phone";

describe("normaliseUkPhone", () => {
  it.each([
    ["07700 900123", "+447700900123"],
    ["07700-900-123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["0044 7700 900123", "+447700900123"],
    ["+44 (0)20 7946 0018", "+442079460018"],
    ["(020) 7946 0018", "+442079460018"],
    ["020.7946.0018", "+442079460018"],
    ["  01632 960 001 ", "+441632960001"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normaliseUkPhone(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "abc",
    "12345",
    "0770090012",
    "077009001234567",
    "+1 415 555 0132",
    "00000000000",
    "call me",
    "07700 900123 ext 5",
  ])("rejects obvious junk: %j", (raw) => {
    expect(normaliseUkPhone(raw)).toBeUndefined();
  });
});

describe("normaliseCallbackPhone", () => {
  it.each([
    ["07700 900123", "+447700900123"],
    ["+44 (0)20 7946 0018", "+442079460018"],
    ["+1 (415) 555-0132", "+14155550132"],
    ["+353 1 234 5678", "+35312345678"],
    ["+91 98765 43210", "+919876543210"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normaliseCallbackPhone(raw)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "12345",
    "0770090012",
    "+1234567",
    "+1234567890123456",
    "+0 415 555 0132",
    "+1 415 555 0132 ext 5",
    "001 415 555 0132",
    // A +44 number must still be a valid UK number.
    "+44 12345678",
  ])("rejects junk: %j", (raw) => {
    expect(normaliseCallbackPhone(raw)).toBeUndefined();
  });
});
