/**
 * O INSERT da campanha — extraído da rota `POST /api/v1/campaigns` pra ter um
 * segundo consumidor: `lib/recuperacao/abrir-rodada.ts` abre campanha de
 * recuperação pelo mesmo caminho, com `origem` e `rodada_data` a mais
 * (migration 0559). Nenhuma validação de entrada mora aqui — quem chama já
 * validou (a rota via `criarCampanhaSchema`; a recuperação via
 * `recuperacaoConfigSchema` e dado já resolvido do Nodus).
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { FILTRO_VAZIO, type FiltroDeAudiencia } from "./audiencia";

export const COLUNAS_DA_CAMPANHA_CRIADA =
  "id, name, status, channel_session_id, snapshot_total, snapshot_eligible, snapshot_excluded, " +
  "scheduled_at, started_at, completed_at, cancelled_at, created_at, created_by, " +
  "pipeline_id, stage_id, agent_id, origem, rodada_data";

export interface DadosDaCampanha {
  name: string;
  description?: string | null;
  channelSessionId: string;
  messageBody?: string | null;
  baseLegal: "consent" | "legitimate_interest";
  liaRef?: string | null;
  audienceFilter?: FiltroDeAudiencia;
  intervaloSegundos?: number | null;
  janelaInicioHora?: number | null;
  janelaFimHora?: number | null;
  tetoDiario?: number | null;
  tetoHorario?: number | null;
  pipelineId?: string | null;
  stageId?: string | null;
  agentId?: string | null;
  /** `null`/omitido = 'manual', o comportamento de toda campanha criada pela tela. */
  origem?: "manual" | "recuperacao";
  /** Obrigatório junto de `origem: 'recuperacao'` — é a chave da unicidade diária (migration 0559). */
  rodadaData?: string | null;
  /** `null` para campanha aberta pelo cron de recuperação — não há usuário. */
  createdBy: string | null;
}

export async function criarCampanha(
  admin: SupabaseClient,
  organizationId: string,
  dados: DadosDaCampanha,
): Promise<{ data: Record<string, unknown> | null; error: PostgrestError | null }> {
  const { data, error } = await admin
    .from("campaigns")
    .insert({
      organization_id: organizationId,
      name: dados.name,
      description: dados.description ?? null,
      channel_session_id: dados.channelSessionId,
      message_body: dados.messageBody ?? null,
      base_legal: dados.baseLegal,
      lia_ref: dados.liaRef ?? null,
      audience_filter: dados.audienceFilter ?? FILTRO_VAZIO,
      intervalo_segundos: dados.intervaloSegundos ?? null,
      janela_inicio_hora: dados.janelaInicioHora ?? null,
      janela_fim_hora: dados.janelaFimHora ?? null,
      teto_diario: dados.tetoDiario ?? null,
      teto_horario: dados.tetoHorario ?? null,
      pipeline_id: dados.pipelineId ?? null,
      stage_id: dados.stageId ?? null,
      agent_id: dados.agentId ?? null,
      origem: dados.origem ?? "manual",
      rodada_data: dados.rodadaData ?? null,
      created_by: dados.createdBy,
    })
    .select(COLUNAS_DA_CAMPANHA_CRIADA)
    .single();
  return { data: data as Record<string, unknown> | null, error };
}
