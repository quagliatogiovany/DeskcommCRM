/**
 * POST /api/internal/provisioning/org — Fase 3 da integração com o Nodus:
 * cria uma organização nova nesta instância, sem passar pela tela de signup.
 *
 * Auth: mesmo padrão de `app/api/internal/agents/run` — `x-internal-secret`
 * (preferido) ou `authorization: Bearer <INTERNAL_SECRET>`.
 *
 * `modelo_loja` (opcional): textos-modelo da atendente, guardados em
 * `onboarding_state.modelo_loja` pro wizard de IA usar quando o dono entrar.
 *
 * Escopo deliberadamente mínimo (não cria usuário nem agente de IA): sem um
 * dono logado não há para quem publicar a 1ª versão (`publishFirstVersion`
 * exige canal de WhatsApp conectado, que só existe depois que alguém entra e
 * pareia o número) nem contexto de onboarding (ramo do negócio, tom de voz)
 * pra escrever um prompt que preste. Isso é passo de uma fase futura (SSO),
 * quando existir um usuário de verdade para logar. Aqui só a organização nasce
 * — os triggers de seed (`trg_semear_tipos_de_agendamento`,
 * `fn_seed_org_llm_defaults`, `trg_seed_default_pipeline_for_org`) já deixam
 * ela num estado usável.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { slugify } from "@/lib/auth/provision";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  org_name: z.string().trim().min(1).max(120),
  /** Textos-modelo da atendente (ver `onboardingStateSchema.modelo_loja`). */
  modelo_loja: z
    .object({
      instrucoes: z.string().max(20000),
      documento: z.string().max(20000),
      faq: z.string().max(50000),
    })
    .optional(),
});

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorize(req: NextRequest): boolean {
  const expected = env.INTERNAL_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers.get("x-internal-secret");
  if (headerSecret && timingSafeEq(headerSecret, expected)) return true;
  const authz = req.headers.get("authorization");
  if (authz) {
    const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (match && timingSafeEq(match[1]!.trim(), expected)) return true;
  }
  return false;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorize(req)) {
    return fail("unauthenticated", "Internal secret missing or invalid.", 401);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      details: parsed.error.flatten(),
    });
  }

  const orgName = parsed.data.org_name;
  const admin = createAdminClient();
  const base = slugify(orgName);

  // Mesmo padrão de corrida do provisionamento por signup: tenta o slug
  // canônico e recua para um sufixo aleatório só em colisão (23505).
  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: orgName,
        legal_name: orgName,
        status: "active",
        ...(parsed.data.modelo_loja ? { onboarding_state: { modelo_loja: parsed.data.modelo_loja } } : {}),
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      return fail("internal_error", `org insert failed: ${error.message}`, 500);
    }
  }
  if (!org) return fail("internal_error", "slug exhausted after 3 attempts", 500);

  void audit({
    action: "tenant.created_by_provisioning_api",
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug, source: "nodus" },
  });

  return ok({ organization_id: org.id, slug: org.slug }, { status: 201 });
}

const deleteSchema = z.object({ organization_id: z.string().uuid() });

// Tabelas que apontam pra channel_sessions/organizations com ON DELETE RESTRICT:
// o Postgres recusaria o delete da org enquanto existirem. Ordem = dependentes antes.
const TABELAS_RESTRICT = ["voice_calls", "messages", "conversations", "ai_agent_versions"] as const;

/**
 * DELETE /api/internal/provisioning/org — o Nodus excluiu a loja e pede a
 * limpeza TOTAL da organização correspondente. Irreversível; idempotente
 * (org inexistente = 200).
 *
 *  1. Desconecta (logout) e apaga as sessões WAHA da org. Falha fechado: sem
 *     WAHA configurado ou se o WAHA recusar, nada é apagado (senão a sessão
 *     ficaria órfã recebendo webhook de uma org que não existe).
 *  2. Apaga o histórico que referencia canais com RESTRICT.
 *  3. Apaga a organização (o resto cascateia).
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  if (!authorize(req)) {
    return fail("unauthenticated", "Internal secret missing or invalid.", 401);
  }
  const raw = await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "organization_id inválido.", 422);
  }
  const orgId = parsed.data.organization_id;
  const admin = createAdminClient();

  const { data: sessions, error: sessErr } = await admin
    .from("channel_sessions")
    .select("id, provider, waha_session_name")
    .eq("organization_id", orgId);
  if (sessErr) return fail("internal_error", `channel_sessions read failed: ${sessErr.message}`, 500);

  const wahaNames = (sessions ?? [])
    .filter((s) => s.provider === CHANNEL_PROVIDER_WAHA && s.waha_session_name)
    .map((s) => s.waha_session_name as string);

  if (wahaNames.length > 0) {
    const waha = getWahaClient();
    if (!waha) {
      return fail("waha_not_configured", "WAHA não configurado — sessões não podem ser removidas.", 503);
    }
    for (const name of wahaNames) {
      try {
        await waha.logoutSession(name);
        await waha.deleteSession(name);
      } catch (err) {
        return fail("waha_error", `Falha ao remover sessão WAHA ${name}: ${wahaFriendlyError(err)}`, 502);
      }
    }
  }

  for (const table of TABELAS_RESTRICT) {
    const { error } = await admin.from(table).delete().eq("organization_id", orgId);
    if (error) return fail("internal_error", `${table} delete failed: ${error.message}`, 500);
  }

  const { error } = await admin.from("organizations").delete().eq("id", orgId);
  if (error) {
    return fail("internal_error", `org delete failed: ${error.message}`, 500);
  }

  void audit({
    action: "tenant.deleted_by_provisioning_api",
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    bypassedRls: true,
    metadata: { source: "nodus", waha_sessions: wahaNames.length },
  });
  return ok({ deleted: true, waha_sessions_removed: wahaNames.length });
}
