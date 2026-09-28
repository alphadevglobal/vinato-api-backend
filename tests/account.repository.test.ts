import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyLegacyPassword } from "../src/account.repository.js";

describe("legacy account password migration", () => {
  it("validates PBKDF2-SHA256 hashes that use the encoded salt", () => {
    const password = "Senha segura 2026";
    const salt = Buffer.from("vinato-test-salt").toString("base64url");
    const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("base64url");

    expect(verifyLegacyPassword(password, `pbkdf2_sha256$100000$${salt}$${hash}`)).toBe(true);
    expect(verifyLegacyPassword("senha incorreta", `pbkdf2_sha256$100000$${salt}$${hash}`)).toBe(false);
  });

  it("validates PBKDF2-SHA256 hashes that use decoded salt bytes", () => {
    const password = "Outra senha segura 2026";
    const salt = Buffer.from("another-vinato-salt").toString("base64url");
    const hash = pbkdf2Sync(password, Buffer.from(salt, "base64url"), 100_000, 32, "sha256").toString("base64url");

    expect(verifyLegacyPassword(password, `pbkdf2_sha256$100000$${salt}$${hash}`)).toBe(true);
  });
});

describe("effective plan", () => {
  it("keeps permanent premium, honours the end date and downgrades after it", async () => {
    const { effectivePlan } = await import("../src/account.repository.js");
    const now = new Date("2026-09-28T12:00:00Z");
    expect(effectivePlan("premium", null, now)).toBe("premium");
    expect(effectivePlan("premium", new Date("2026-10-28T23:59:59Z"), now)).toBe("premium");
    expect(effectivePlan("premium", new Date("2026-09-27T23:59:59Z"), now)).toBe("free");
    expect(effectivePlan("free", null, now)).toBe("free");
  });
});
