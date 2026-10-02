import { randomBytes } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { AccountRepository } from "../src/account.repository.js";
import { createApp } from "../src/app.js";
import { decryptField, normalizeCpf, normalizePhone, parseBirthDate } from "../src/personal-data.js";
import { fullDatabase } from "./helpers/full-db.js";

const CPF = "529.982.247-25";
const OTHER_CPF = "111.444.777-35";
const PHONE = { country: "BR", dialCode: "+55", areaCode: "85", number: "99999-9999" };
const signup = (overrides: Record<string, unknown> = {}) => ({
  displayName: "Ana Maria Souza", email: "ana@vinato.test", password: "segredo123", cpf: CPF, birthDate: "1990-05-20",
  phone: PHONE, acceptTerms: true, adult: true, marketing: true, ...overrides,
});

beforeAll(() => { process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString("base64"); });

async function setup() {
  const { db, pool } = await fullDatabase();
  const accounts = new AccountRepository(pool);
  const app = createApp({ wineRepository: {} as never, wineScanner: {} as never, accountRepository: accounts });
  return { db, accounts, app };
}

describe("personal data rules", () => {
  it("checks the CPF digits, the date of birth and the phone", () => {
    expect(normalizeCpf(CPF)).toBe("52998224725");
    expect(normalizeCpf("529.982.247-24")).toBeNull();
    expect(normalizeCpf("111.111.111-11")).toBeNull();
    expect(parseBirthDate("2008-10-03", new Date("2026-10-02T12:00:00Z"))?.age).toBe(17);
    expect(parseBirthDate("2008-10-02", new Date("2026-10-02T12:00:00Z"))?.age).toBe(18);
    expect(parseBirthDate("1990-02-30")).toBeNull();
    expect(normalizePhone(PHONE)).toEqual({ country: "BR", dialCode: "55", areaCode: "85", number: "999999999" });
    expect(normalizePhone({ ...PHONE, areaCode: "8" })).toBeNull();
    expect(normalizePhone({ country: "PT", dialCode: "351", areaCode: "", number: "912345678" })).toEqual({ country: "PT", dialCode: "351", areaCode: "", number: "912345678" });
  });
});

describe("cadastro with CPF, date of birth, phone and consents", () => {
  it("creates the account with the data encrypted, the consents logged and the profile readable only by its owner", async () => {
    const { db, app } = await setup();
    const created = await request(app).post("/auth/register").send(signup()).expect(201);
    expect(created.body.user.profileComplete).toBe(true);

    const row = (await db.query<Record<string, string>>(`select * from app_users where email = 'ana@vinato.test'`)).rows[0];
    expect(JSON.stringify(row)).not.toContain("52998224725");
    expect(JSON.stringify(row)).not.toContain("1990-05-20");
    expect(JSON.stringify(row)).not.toContain("999999999");
    expect(decryptField(row.cpf_encrypted)).toBe("52998224725");
    expect(row.terms_version).toBe("0-provisorio");
    const consents = (await db.query<{ kind: string; granted: boolean }>(`select kind, granted from user_consents order by kind`)).rows;
    expect(consents).toEqual([{ kind: "adult", granted: true }, { kind: "marketing", granted: true }, { kind: "terms", granted: true }]);

    const profile = await request(app).get("/me/profile").set("Authorization", `Bearer ${created.body.token}`).expect(200);
    expect(profile.headers["cache-control"]).toBe("no-store");
    expect(profile.body).toMatchObject({ fullName: "Ana Maria Souza", cpf: "52998224725", birthDate: "1990-05-20", phone: { country: "BR", dialCode: "55", areaCode: "85", number: "999999999" }, marketingOptIn: true, termsCurrent: true });
    await request(app).get("/me/profile").expect(401);
  });

  it("allows one account per CPF and requires the two confirmations, the full name and 18 years", async () => {
    const { app } = await setup();
    await request(app).post("/auth/register").send(signup()).expect(201);
    const twice = await request(app).post("/auth/register").send(signup({ email: "outra@vinato.test", cpf: "52998224725" })).expect(409);
    expect(twice.body.message).toContain("CPF");
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF, acceptTerms: false })).expect(400);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF, adult: undefined })).expect(400);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF, displayName: "Ana" })).expect(400);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF, birthDate: "2015-01-01" })).expect(400);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: "123" })).expect(400);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF, phone: undefined, marketing: false })).expect(201);
  });

  it("asks whoever came by Apple or Google for the CPF, the date of birth and the consents", async () => {
    const { db, accounts, app } = await setup();
    const social = await accounts.socialLogin("apple", "apple-sub-1", "joao@privaterelay.appleid.com", "João Lima");
    expect(social.user.profileComplete).toBe(false);
    const auth = { Authorization: `Bearer ${social.token}` };
    await request(app).put("/me/profile").set(auth).send({ birthDate: "1985-01-10", acceptTerms: true, adult: true }).expect(400);
    await request(app).put("/me/profile").set(auth).send({ cpf: CPF, birthDate: "1985-01-10", adult: true }).expect(400);
    const done = await request(app).put("/me/profile").set(auth).send({ cpf: CPF, birthDate: "1985-01-10", acceptTerms: true, adult: true, marketing: false }).expect(200);
    expect(done.body.user.profileComplete).toBe(true);
    expect(done.body.profile).toMatchObject({ cpf: "52998224725", socialLogin: true, marketingOptIn: false });

    // A new version of the Termos de Uso asks for it again.
    await db.query(`insert into legal_documents (kind, version, title, body, published_at) values ('terms', '1', 'Termos de Uso', 'Texto final', now() + interval '1 second')`);
    expect((await request(app).get("/auth/me").set(auth).expect(200)).body.profileComplete).toBe(false);
    expect((await request(app).get("/legal/terms").expect(200)).body).toMatchObject({ version: "1", body: "Texto final" });
  });

  it("edits every field of the cadastro in the profile, keeping the CPF unique", async () => {
    const { db, app } = await setup();
    const first = await request(app).post("/auth/register").send(signup()).expect(201);
    await request(app).post("/auth/register").send(signup({ email: "b@vinato.test", cpf: OTHER_CPF })).expect(201);
    const auth = { Authorization: `Bearer ${first.body.token}` };
    const edited = await request(app).put("/me/profile").set(auth)
      .send({ displayName: "Ana Maria Souza Lima", email: "ana.lima@vinato.test", birthDate: "1991-06-21", phone: { country: "PT", dialCode: "351", areaCode: "", number: "912345678" }, marketing: false }).expect(200);
    expect(edited.body.user).toMatchObject({ displayName: "Ana Maria Souza Lima", email: "ana.lima@vinato.test" });
    expect(edited.body.profile).toMatchObject({ birthDate: "1991-06-21", phone: { country: "PT", number: "912345678" }, marketingOptIn: false });
    await request(app).put("/me/profile").set(auth).send({ cpf: OTHER_CPF }).expect(409);
    await request(app).put("/me/profile").set(auth).send({ phone: null }).expect(200);
    const consents = (await db.query<{ kind: string; granted: boolean }>(`select kind, granted from user_consents where kind = 'marketing' order by created_at`)).rows;
    expect(consents.map((item) => item.granted)).toEqual([true, true, false]);
  });
});
