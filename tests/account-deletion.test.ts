import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountRepository, isTeamAccount } from "../src/account.repository.js";
import { createApp } from "../src/app.js";

describe("the user deletes their own account", () => {
  let db: PGlite;
  let accounts: AccountRepository;
  const user = async (email: string, role = "user") => (await db.query<{ id: string }>(`insert into app_users (email, role) values ($1, $2) returning id`, [email, role])).rows[0].id;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      create table app_users (id uuid primary key default gen_random_uuid(), email text not null, role text not null default 'user');
      create table user_sessions (token_hash text primary key, user_id uuid not null references app_users(id) on delete cascade);
      create table user_cellar (user_id uuid not null references app_users(id) on delete cascade, wine text);
      create table users (id uuid primary key, role text not null);
      create table password_credentials (user_id uuid primary key references users(id) on delete cascade, password_hash text);`);
    accounts = new AccountRepository(db as unknown as pg.Pool);
  });

  it("removes the account, its data and its legacy login", async () => {
    const id = await user("cliente@exemplo.com");
    await db.query(`insert into user_sessions values ('t', $1)`, [id]);
    await db.query(`insert into user_cellar values ($1, 'Malbec')`, [id]);
    await db.query(`insert into users values ($1, 'user')`, [id]);
    await db.query(`insert into password_credentials values ($1, 'x')`, [id]);
    expect(await accounts.deleteAccount(id)).toBe(true);
    for (const table of ["app_users", "user_sessions", "user_cellar", "users", "password_credentials"]) {
      expect((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    }
  });

  it("never deletes a panel admin's legacy login, nor team accounts", async () => {
    const id = await user("cliente2@exemplo.com");
    await db.query(`insert into users values ($1, 'admin')`, [id]);
    await accounts.deleteAccount(id);
    expect((await db.query(`select * from users`)).rows).toHaveLength(1);
    const admin = await user("contato@vinatoapp.com", "owner");
    await expect(accounts.deleteAccount(admin)).rejects.toThrow("PROTECTED_ACCOUNT");
    expect(isTeamAccount("user", "Contato@VinatoApp.com")).toBe(true);
    expect(isTeamAccount("user", "a@b.c")).toBe(false);
  });

  it("works without the legacy tables", async () => {
    await db.exec(`drop table password_credentials; drop table users;`);
    const id = await user("cliente3@exemplo.com");
    expect(await accounts.deleteAccount(id)).toBe(true);
    expect((await db.query(`select * from app_users`)).rows).toHaveLength(0);
  });

  it("DELETE /me requires the confirmation and refuses team accounts", async () => {
    const deleteAccount = vi.fn(async () => true);
    const make = (email = "a@b.c") => createApp({ wineRepository: {} as never, wineScanner: {} as never,
      accountRepository: { getUser: vi.fn(async () => ({ id: "u1", email, role: "user", plan: "free", status: "active" })), deleteAccount } as never });
    await request(make()).delete("/me").set("Authorization", "Bearer t").send({}).expect(400);
    expect(deleteAccount).not.toHaveBeenCalled();
    await request(make()).delete("/me").set("Authorization", "Bearer t").send({ confirm: true }).expect(204);
    expect(deleteAccount).toHaveBeenCalledWith("u1");
    deleteAccount.mockRejectedValueOnce(new Error("PROTECTED_ACCOUNT"));
    await request(make()).delete("/me").set("Authorization", "Bearer t").send({ confirm: true }).expect(403);
    await request(make()).delete("/me").send({ confirm: true }).expect(401);
  });
});
