/**
 * GET /api/v1/recuperacao/config — a configuração da organização (ou os
 * defaults do schema, se a organização nunca configurou).
 * PUT /api/v1/recuperacao/config — grava.
 *
 * Papel: `manager`, mesma régua de Campanhas (migration 0559 RLS) — disparar
 * WhatsApp em massa pra base de clientes não é gesto de `viewer` nem `agent`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { carregarConfig, salvarConfig } from "@/lib/recuperacao/config";
import { recuperacaoConfigSchema } from "@/lib/recuperacao/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  ativo: false,
  dias_sem_pedido: 30,
  nao_repetir_antes_dias: 30,
  mensagem: "",
  channel_session_id: null,
  janela_inicio_hora: 9,
  janela_fim_hora: 20,
  recorrencia: "manual" as const,
  dia_semana: null,
  hora_disparo: 10,
  limite_por_rodada: 500,
  base_legal: "legitimate_interest" as const,
  lia_ref: null,
};

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "recuperacao_config" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const config = await carregarConfig(admin, authz.org.orgId);
  if (!config) return ok({ organization_id: authz.org.orgId, ...DEFAULTS }, { requestId });

  return ok(
    {
      organization_id: config.organizationId,
      ativo: config.ativo,
      dias_sem_pedido: config.diasSemPedido,
      nao_repetir_antes_dias: config.naoRepetirAntesDias,
      mensagem: config.mensagem,
      channel_session_id: config.channelSessionId,
      janela_inicio_hora: config.janelaInicioHora,
      janela_fim_hora: config.janelaFimHora,
      recorrencia: config.recorrencia,
      dia_semana: config.diaSemana,
      hora_disparo: config.horaDisparo,
      limite_por_rodada: config.limitePorRodada,
      base_legal: config.baseLegal,
      lia_ref: config.liaRef,
      updated_at: config.updatedAt,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "recuperacao_config" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = recuperacaoConfigSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("recuperacao_config_invalida", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = createAdminClient();

  if (parsed.data.channel_session_id) {
    const { data: canal } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.channel_session_id)
      .maybeSingle();
    if (!canal) {
      return fail(
        "campanha_canal_indisponivel",
        t("Escolha uma conexão de WhatsApp desta organização."),
        409,
        { requestId },
      );
    }
  }

  const config = await salvarConfig(admin, authz.org.orgId, parsed.data, authz.user.id);

  void audit({
    action: "recuperacao_config.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "recuperacao_config",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { ativo: config.ativo, recorrencia: config.recorrencia },
  });

  return ok(
    {
      organization_id: config.organizationId,
      ativo: config.ativo,
      dias_sem_pedido: config.diasSemPedido,
      nao_repetir_antes_dias: config.naoRepetirAntesDias,
      mensagem: config.mensagem,
      channel_session_id: config.channelSessionId,
      janela_inicio_hora: config.janelaInicioHora,
      janela_fim_hora: config.janelaFimHora,
      recorrencia: config.recorrencia,
      dia_semana: config.diaSemana,
      hora_disparo: config.horaDisparo,
      limite_por_rodada: config.limitePorRodada,
      base_legal: config.baseLegal,
      lia_ref: config.liaRef,
      updated_at: config.updatedAt,
    },
    { requestId },
  );
}
