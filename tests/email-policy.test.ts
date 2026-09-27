import { describe, expect, it } from "vitest";
import { isDisposableEmailAddress } from "../src/email-policy.js";

describe("temporary email policy", () => {
  it("rejects known disposable providers", () => {
    expect(isDisposableEmailAddress("teste@mailinator.com")).toBe(true);
    expect(isDisposableEmailAddress("teste@yopmail.com")).toBe(true);
  });

  it("rejects subdomains of disposable providers", () => {
    expect(isDisposableEmailAddress("teste@inbox.mailinator.com")).toBe(true);
  });

  it("allows permanent providers and the Vinato domain", () => {
    expect(isDisposableEmailAddress("pessoa@gmail.com")).toBe(false);
    expect(isDisposableEmailAddress("contato@vinatoapp.com")).toBe(false);
  });
});
