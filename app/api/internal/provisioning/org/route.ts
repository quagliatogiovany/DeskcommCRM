/**
 * POST /api/internal/provisioning/org — Fase 3 da integração com o Nodus:
 * cria uma organização nova nesta instância, sem passar pela tela de signup.
 *
 * Auth: mesmo padrão de `app/api/internal/agents/run` — `x-internal-secret`
 * (preferido) ou `authorization: Bearer <INTERNAL_SECRET>`.
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  org_name: z.string().trim().min(1).max(120),
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
