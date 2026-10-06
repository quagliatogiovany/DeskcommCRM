/**
 * O CRON DA RECUPERAÇÃO — varre as organizações que configuraram recorrência
 * (diária/semanal) e abre a rodada na hora local de cada uma, pela mesma
 * `lib/recuperacao/abrir-rodada.ts` que o botão "Disparar agora" chama.
 *
 * Mesmo desenho de `cron/contact-birthdays`: roda de hora em hora, a hora é a
 * de PAREDE da organização (nunca UTC), e configuração `recorrencia: 'manual'`
 * nunca é varrida aqui — só quem pediu recorrência automática.
 *
 * A idempotência do dia não depende deste cron rodar exatamente uma vez: é o
 * índice único `(organization_id, rodada_data)` (migration 0559) que barra a
 * segunda rodada, dentro de `abrirRodada` — reinício do worker ou dois nós no
 * mesmo minuto não duplicam o disparo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { abrirRodada } from "@/lib/recuperacao/abrir-rodada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const FUSO_PADRAO = "America/Sao_Paulo";
/** O PostgREST monta a lista do `in` dentro da URL, e URL tem fim. */
const TAMANHO_DO_LOTE = 100;

/** 0 (domingo) a 6 (sábado) — mesma convenção de `Date#getDay()`. */
function diaDaSemana(ano: number, mes: number, dia: number): number {
  return new Date(ano, mes - 1, dia).getDay();
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const { data: configs, error: erroConfigs } = await admin
    .from("recuperacao_config")
    .select("organization_id, hora_disparo, recorrencia, dia_semana")
    .eq("ativo", true)
    .not("channel_session_id", "is", null)
    .neq("recorrencia", "manual");
  if (erroConfigs) {
    logger.error("[recuperacao-clientes] consulta de config falhou", {
      error: erroConfigs.message,
      requestId,
    });
    return fail("internal_error", "Falha ao buscar configuração.", 500, { requestId });
  }
  if (!configs?.length) {
    return ok({ organizacoes: 0, disparadas: 0, puladas: {} }, { requestId });
  }

  const paradas = new Set(await idsDeOrgsParadas(admin));
  const orgIds = [...new Set(configs.map((c) => c.organization_id as string))];
  const { data: organizacoes } = await admin
    .from("organizations")
    .select("id, timezone")
    .in("id", orgIds.slice(0, TAMANHO_DO_LOTE));
  const fusoPorOrg = new Map(
    (organizacoes ?? []).map((o) => [o.id as string, (o.timezone as string | null) ?? FUSO_PADRAO]),
  );

  let disparadas = 0;
  const puladas: Record<string, number> = {};
  const pular = (motivo: string) => {
    puladas[motivo] = (puladas[motivo] ?? 0) + 1;
  };

  for (const config of configs) {
    const org = config.organization_id as string;
    if (paradas.has(org)) {
      pular("org_parada");
      continue;
    }
    const fuso = fusoPorOrg.get(org) ?? FUSO_PADRAO;

    let parede: ReturnType<typeof partesNoFuso>;
    try {
      parede = partesNoFuso(agora, fuso);
    } catch {
      // Fuso inválido numa organização não derruba a varredura das outras.
      pular("fuso_invalido");
      continue;
    }
    if (parede.hora !== config.hora_disparo) continue;
    if (config.recorrencia === "semanal") {
      const dia = diaDaSemana(parede.ano, parede.mes, parede.dia);
      if (dia !== config.dia_semana) continue;
    }

    try {
      const resultado = await abrirRodada(admin, org, agora);
      if (resultado.ok) {
        disparadas += 1;
      } else {
        pular(resultado.motivo);
      }
    } catch (err) {
      logger.error("[recuperacao-clientes] abrirRodada falhou", {
        organization_id: org,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      pular("erro_ao_abrir");
    }
  }

  // Rodada que não disparou nada não é mutação, e não audita — CLAUDE.md
  // §Audit log; `tests/unit/cron-audita-so-quando-ha-efeito.test.ts` varre o
  // AST de toda rota de `app/api/v1/cron/` atrás de `audit` incondicional.
  if (disparadas > 0) {
    await audit({
      action: "recuperacao.disparada_pelo_cron",
      resourceType: "campaign",
      metadata: { disparadas, puladas },
      requestId,
    });
  }

  return ok({ organizacoes: configs.length, disparadas, puladas }, { requestId });
}

export const GET = handle;
export const POST = handle;
