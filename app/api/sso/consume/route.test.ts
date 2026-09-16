import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { verifySsoToken } from "@/lib/auth/sso-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/sso-token", () => ({ verifySsoToken: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));

const ORG = { id: "22222222-2222-4222-8222-222222222222" };
const PAYLOAD = {
  organization_id: ORG.id,
  email: "dono@loja.example",
  name: "Loja Teste",
  exp: Math.floor(Date.now() / 1000) + 60,
};
const USUARIO_EXISTENTE = { id: "11111111-1111-4111-8111-111111111111", email: PAYLOAD.email };
const HASHED_TOKEN = "hash-abc";

interface Cenario {
  org: { id: string } | null;
  usuarios: Array<{ id: string; email: string }>;
  membership: { user_id: string; revoked_at: string | null } | null;
  createUserResult?: { data: { user: typeof USUARIO_EXISTENTE } | null; error: { message: string } | null };
  generateLinkResult?: {
    data: { properties: { hashed_token: string } } | null;
    error: { message: string } | null;
  };
  verifyOtpError?: { message: string } | null;
}

function montarAdminFake(c: Cenario) {
  const insertMembership = vi.fn(async () => ({ data: null, error: null }));
  const updateMembership = vi.fn(() => ({
    eq: () => ({ eq: async () => ({ data: null, error: null }) }),
  }));
  const createUser = vi.fn(async () => c.createUserResult ?? { data: null, error: { message: "not stubbed" } });
  const generateLink = vi.fn(
    async () => c.generateLinkResult ?? { data: { properties: { hashed_token: HASHED_TOKEN } }, error: null },
  );
  const listUsers = vi.fn(async () => ({ data: { users: c.usuarios } }));

  const admin = {
    auth: { admin: { listUsers, createUser, generateLink } },
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: c.org }) }) }) };
      }
      if (table === "user_organizations") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: c.membership }) }) }) }),
          insert: insertMembership,
          update: updateMembership,
        };
      }
      throw new Error(`tabela não stubada neste teste: ${table}`);
    }),
  };
  return { admin, insertMembership, updateMembership, createUser, generateLink };
}

function requisicao(qs: string) {
  return new NextRequest(`http://localhost:3000/api/sso/consume?${qs}`);
}

function destino(res: Response): string {
  const url = new URL(res.headers.get("location") ?? "");
  return url.pathname + url.search;
}

describe("GET /api/sso/consume", () => {
  const verifyOtp = vi.fn(async () => ({ error: null as { message: string } | null }));

  beforeEach(() => {
    vi.clearAllMocks();
    verifyOtp.mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
      auth: { verifyOtp },
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  });

  it("token ausente: recusa sem verificar nada", async () => {
    const { GET } = await import("./route");
    const res = await GET(requisicao(""));
    expect(destino(res)).toBe("/login?error=sso_invalido");
    expect(vi.mocked(verifySsoToken)).not.toHaveBeenCalled();
  });

  it("token inválido ou expirado: recusa e audita a falha", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(null);
    const { GET } = await import("./route");
    const res = await GET(requisicao("token=lixo"));
    expect(destino(res)).toBe("/login?error=sso_invalido");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.sso_login_failed" }),
    );
  });

  it("organização não encontrada: recusa", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin } = montarAdminFake({ org: null, usuarios: [], membership: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));
    expect(destino(res)).toBe("/login?error=sso_invalido");
  });

  it("usuário novo, sem membership: cria usuário, grava vínculo admin e loga", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin, insertMembership, createUser } = montarAdminFake({
      org: ORG,
      usuarios: [],
      membership: null,
      createUserResult: { data: { user: USUARIO_EXISTENTE }, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: PAYLOAD.email, user_metadata: { full_name: PAYLOAD.name } }),
    );
    expect(insertMembership).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USUARIO_EXISTENTE.id, organization_id: ORG.id, role: "admin" }),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: HASHED_TOKEN });
    expect(destino(res)).toBe("/onboarding/welcome");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.sso_login", actorUserId: USUARIO_EXISTENTE.id }),
    );
  });

  it("usuário e membership já existentes: não cria de novo, só loga (idempotente)", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin, insertMembership, updateMembership, createUser } = montarAdminFake({
      org: ORG,
      usuarios: [USUARIO_EXISTENTE],
      membership: { user_id: USUARIO_EXISTENTE.id, revoked_at: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));

    expect(createUser).not.toHaveBeenCalled();
    expect(insertMembership).not.toHaveBeenCalled();
    expect(updateMembership).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/onboarding/welcome");
  });

  it("membership revogada: reativa em vez de recusar", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin, updateMembership } = montarAdminFake({
      org: ORG,
      usuarios: [USUARIO_EXISTENTE],
      membership: { user_id: USUARIO_EXISTENTE.id, revoked_at: "2026-01-01T00:00:00Z" },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));

    expect(updateMembership).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: null, role: "admin" }),
    );
    expect(destino(res)).toBe("/onboarding/welcome");
  });

  it("generateLink falha: recusa com erro próprio, não deixa sem saída", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin } = montarAdminFake({
      org: ORG,
      usuarios: [USUARIO_EXISTENTE],
      membership: { user_id: USUARIO_EXISTENTE.id, revoked_at: null },
      generateLinkResult: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));
    expect(destino(res)).toBe("/login?error=sso_falhou");
  });

  it("verifyOtp falha: recusa em vez de deixar sessão pela metade", async () => {
    vi.mocked(verifySsoToken).mockReturnValue(PAYLOAD);
    const { admin } = montarAdminFake({
      org: ORG,
      usuarios: [USUARIO_EXISTENTE],
      membership: { user_id: USUARIO_EXISTENTE.id, revoked_at: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);
    verifyOtp.mockResolvedValue({ error: { message: "invalid token" } });

    const { GET } = await import("./route");
    const res = await GET(requisicao("token=tok"));
    expect(destino(res)).toBe("/login?error=sso_falhou");
  });
});
