/**
 * GET /api/sso/consume — Fase 5 da integração com o Nodus: troca um token
 * assinado (`lib/auth/sso-token.ts`) por uma sessão Supabase real, sem senha.
 *
 * Destino do botão "Abrir CRM" em `/admin/integrations` do Nodus (nova aba —
 * `docs/backlog/crm-externo-deskcomm-plano.md`, Fase 5 lá). O Nodus nunca
 * chama esta rota via fetch/JS: é sempre navegação de topo (`<a target="_blank">`
 * ou redirect 302), porque o que ela faz é gravar cookie de sessão no
 * NAVEGADOR do dono da loja — fetch cross-origin não serviria esse propósito.
 *
 * Usa o mesmo mecanismo `token_hash` que `app/auth/confirm/route.ts` usa para
 * o link de confirmação por e-mail (ver o comentário longo lá sobre por que
 * NÃO é o formato `code`/PKCE): `admin.generateLink({ type: "magiclink" })`
 * gera um hashed_token sem mandar e-mail nenhum, e `verifyOtp` na sequência
 * grava os cookies de sessão via `@supabase/ssr`. Não depende de cookie
 * prévio (diferente do `code`), o que é o que permite a sessão nascer na
 * PRIMEIRA navegação vinda de fora.
 *
 * Usuário e vínculo nascem aqui, sob demanda: a organização (Fase 3) já
 * existe, mas sem dono — é o "achado que reduziu o escopo" registrado na
 * Fase 3 do plano. `email` identifica de forma estável quem é o dono entre
 * chamadas (múltiplos cliques = mesmo usuário, idempotente).
 */
import { createHash } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { verifySsoToken } from "@/lib/auth/sso-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// O cookie de sessão é SameSite=Strict e esta rota é alcançada por navegação
// vinda do Nodus (outro site): um 302 direto pra tela autenticada segue sendo
// parte dessa cadeia cross-site, o navegador NÃO envia o cookie recém-gravado e
// o `proxy` manda pro /login. Entregar um documento same-origin (que já leva o
// Set-Cookie) e navegar DELE restaura o envio — mesma técnica de
// `app/auth/social-return/route.ts`. Destino fixo; nada da query é refletido.
function entregaComSessao(path: string): Response {
  const script = `window.location.replace(${JSON.stringify(path)});`;
  const hash = createHash("sha256").update(script).digest("base64");
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Entrando…</title><body><p>Entrando…</p><a href="${path}">Continuar</a><script>${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  const token = request.nextUrl.searchParams.get("token");
  if (!token) return redirectTo("/login?error=sso_invalido");

  const payload = verifySsoToken(token);
  if (!payload) {
    void audit({ action: "auth.sso_login_failed", metadata: { reason: "token_invalido_ou_expirado" } });
    return redirectTo("/login?error=sso_invalido");
  }

  const admin = createAdminClient();

  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("id", payload.organization_id)
    .maybeSingle<{ id: string }>();
  if (!org) {
    void audit({
      action: "auth.sso_login_failed",
      organizationId: payload.organization_id,
      metadata: { reason: "organizacao_nao_encontrada" },
    });
    return redirectTo("/login?error=sso_invalido");
  }

  // Acha o usuário Supabase deste e-mail, ou cria — SSO nunca pede senha.
  const { data: listagem } = await admin.auth.admin.listUsers({ perPage: 200 });
  let usuario = listagem?.users.find((u) => u.email === payload.email) ?? null;
  if (!usuario) {
    const criado = await admin.auth.admin.createUser({
      email: payload.email,
      email_confirm: true,
      user_metadata: payload.name ? { full_name: payload.name } : {},
    });
    if (criado.error || !criado.data?.user) {
      void audit({
        action: "auth.sso_login_failed",
        organizationId: org.id,
        metadata: { reason: "criacao_de_usuario_falhou", detalhe: criado.error?.message },
      });
      return redirectTo("/login?error=sso_falhou");
    }
    usuario = criado.data.user;
  }

  // Vínculo admin na org — idempotente, revive membership revogada.
  const { data: membership } = await admin
    .from("user_organizations")
    .select("user_id, revoked_at")
    .eq("user_id", usuario.id)
    .eq("organization_id", org.id)
    .maybeSingle<{ user_id: string; revoked_at: string | null }>();
  if (!membership) {
    await admin.from("user_organizations").insert({
      user_id: usuario.id,
      organization_id: org.id,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
  } else if (membership.revoked_at) {
    await admin
      .from("user_organizations")
      .update({ revoked_at: null, role: "admin" })
      .eq("user_id", usuario.id)
      .eq("organization_id", org.id);
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: payload.email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    void audit({
      action: "auth.sso_login_failed",
      actorUserId: usuario.id,
      organizationId: org.id,
      metadata: { reason: "generate_link_falhou", detalhe: linkError?.message },
    });
    return redirectTo("/login?error=sso_falhou");
  }

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: hashedToken,
  });
  if (verifyError) {
    void audit({
      action: "auth.sso_login_failed",
      actorUserId: usuario.id,
      organizationId: org.id,
      metadata: { reason: "verify_otp_falhou", detalhe: verifyError.message },
    });
    return redirectTo("/login?error=sso_falhou");
  }

  void audit({
    action: "auth.sso_login",
    actorUserId: usuario.id,
    organizationId: org.id,
    metadata: { source: "nodus" },
  });

  return entregaComSessao("/onboarding/welcome");
}
