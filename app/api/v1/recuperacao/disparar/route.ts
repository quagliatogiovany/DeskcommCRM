/**
 * POST /api/v1/recuperacao/disparar — botão "Disparar agora" da tela. Abre uma
 * rodada de recuperação fora da hora programada, pela mesma
 * `lib/recuperacao/abrir-rodada.ts` que o cron chama. A trava contra duplicar
 * é a mesma dos dois caminhos: `unique (organization_id, rodada_data)`
 * (migration 0559) — clicar duas vezes no mesmo dia dá 409, não duas campanhas.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { abrirRodada } from "@/lib/recuperacao/abrir-rodada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  recuperacao_nao_configurada: "Configure a mensagem, o dias sem pedido e a conexão de WhatsApp antes de disparar.",
  recuperacao_sem_inativos: "Nenhum cliente inativo agora (ou todos já receberam recuperação recentemente).",
  recuperacao_rodada_ja_aberta_hoje: "Já existe uma rodada de recuperação disparada hoje.",
};

const STATUS_POR_MOTIVO: Record<string, number> = {
  recuperacao_nao_configurada: 409,
  recuperacao_sem_inativos: 422,
  recuperacao_rodada_ja_aberta_hoje: 409,
};

export async function POST(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "recuperacao_disparar" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const admin = createAdminClient();

  let resultado;
  try {
    resultado = await abrirRodada(admin, authz.org.orgId);
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    if (mensagem.includes("nodus_nao_configurado") || mensagem.includes("nodus_org_lookup_falhou")) {
      return fail(
        "recuperacao_nao_configurada_no_nodus",
        t("Esta loja ainda não está ligada ao Nodus."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", mensagem, 502, { requestId });
  }

  if (!resultado.ok) {
    return fail(
      resultado.motivo,
      t(MENSAGEM_POR_MOTIVO[resultado.motivo] ?? resultado.motivo),
      STATUS_POR_MOTIVO[resultado.motivo] ?? 422,
      { requestId },
    );
  }

  void audit({
    action: "recuperacao.disparada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "campaign",
    resourceId: resultado.campanhaId,
    requestId,
    metadata: { total: resultado.total, elegiveis: resultado.elegiveis, origem: "manual" },
  });

  return ok(
    { campanha_id: resultado.campanhaId, total: resultado.total, elegiveis: resultado.elegiveis },
    { requestId },
  );
}
