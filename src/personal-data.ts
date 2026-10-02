import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Personal data of the account (CPF, date of birth, phone): encrypted in the
 * database with AES-256-GCM, with the key outside it (PII_ENCRYPTION_KEY, 32 bytes
 * in base64, set only in the API's environment). A copy of the database alone shows
 * none of them. The CPF also gets a keyed hash (HMAC-SHA256), so one CPF opens one
 * account without the CPF being searchable or readable.
 */
const VERSION = "v1";

function masterKey() {
  const raw = process.env.PII_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PII_KEY_MISSING");
  return key;
}
const derived = (info: string) => Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), info, 32));

export function encryptField(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived("vinato-pii-encryption"), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function decryptField(stored: unknown): string | null {
  if (typeof stored !== "string" || !stored.startsWith(`${VERSION}:`)) return null;
  const raw = Buffer.from(stored.slice(VERSION.length + 1), "base64");
  const decipher = createDecipheriv("aes-256-gcm", derived("vinato-pii-encryption"), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** The CPF's keyed hash: equal CPFs give equal hashes; the hash does not give the CPF back. */
export function cpfHash(cpf: string) {
  return createHmac("sha256", derived("vinato-cpf-index")).update(cpf).digest("hex");
}

/** "123.456.789-09" → "12345678909" when the check digits are right; null otherwise. */
export function normalizeCpf(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  const check = (length: number) => {
    const sum = [...digits.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]) ? digits : null;
}

export const ADULT_AGE = 18;

/** "YYYY-MM-DD" of a real past date, with the age on `today`; null otherwise. */
export function parseBirthDate(value: unknown, today = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900) return null;
  let age = today.getUTCFullYear() - year;
  if (today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)) age -= 1;
  if (age < 0) return null;
  return { value: match[0], age };
}

export type Phone = { country: string; dialCode: string; areaCode: string; number: string };

/**
 * The phone as the app sends it: the country (ISO code) and its dial code chosen in a
 * list, then the area code (DDD) and the number. Brazil: a 2-digit DDD and 8 or 9
 * digits. Elsewhere: an area code when the country uses one, and at most 15 digits in all.
 */
export function normalizePhone(value: unknown): Phone | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const country = String(input.country ?? "").trim().toUpperCase();
  const dialCode = String(input.dialCode ?? "").replace(/\D/g, "");
  const areaCode = String(input.areaCode ?? "").replace(/\D/g, "");
  const number = String(input.number ?? "").replace(/\D/g, "");
  if (!/^[A-Z]{2}$/.test(country) || !/^\d{1,4}$/.test(dialCode)) return null;
  if (country === "BR") {
    if (dialCode !== "55" || !/^[1-9][1-9]$/.test(areaCode) || !/^\d{8,9}$/.test(number)) return null;
  } else if (number.length < 4 || dialCode.length + areaCode.length + number.length > 15 || areaCode.length > 5) return null;
  return { country, dialCode, areaCode, number };
}
