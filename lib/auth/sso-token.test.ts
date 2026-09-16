import { describe, it, expect } from "vitest";
import { signSsoToken, verifySsoToken, SSO_TTL_SECONDS } from "./sso-token";

const base = () => ({
  organization_id: "22222222-2222-4222-8222-222222222222",
  email: "dono@loja.example",
  name: "Loja Teste",
  exp: Math.floor(Date.now() / 1000) + SSO_TTL_SECONDS,
});

describe("sso-token", () => {
  it("sign+verify roundtrip recovers payload", () => {
    const payload = base();
    const token = signSsoToken(payload);
    expect(verifySsoToken(token)).toEqual(payload);
  });

  it("accepts a null name", () => {
    const payload = { ...base(), name: null };
    const token = signSsoToken(payload);
    expect(verifySsoToken(token)).toEqual(payload);
  });

  it("returns null for expired token", () => {
    const expired = { ...base(), exp: Math.floor(Date.now() / 1000) - 10 };
    const token = signSsoToken(expired);
    expect(verifySsoToken(token)).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signSsoToken(base());
    const [body, sig] = token.split(".") as [string, string];
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifySsoToken(`${body}.${flipped}`)).toBeNull();
  });

  it("returns null for tampered body", () => {
    const token = signSsoToken(base());
    const [body, sig] = token.split(".") as [string, string];
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    expect(verifySsoToken(`${flipped}.${sig}`)).toBeNull();
  });

  it("returns null for malformed token (no dot)", () => {
    expect(verifySsoToken("notatoken")).toBeNull();
  });

  it("returns null for invalid organization_id or email", () => {
    expect(verifySsoToken(signSsoToken({ ...base(), organization_id: "not-uuid" }))).toBeNull();
    expect(verifySsoToken(signSsoToken({ ...base(), email: "not-an-email" }))).toBeNull();
  });
});
