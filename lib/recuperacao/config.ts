/**
 * A configuração por organização — tabela própria (migration 0559), não
 * `organizations.settings`. Ausência de linha = recuperação nunca configurada
 * nesta organização (diferente de `ativo=false`, que é "configurada e pausada").
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RecuperacaoConfigEntrada } from "./schemas";

export interface RecuperacaoConfig {
  organizationId: string;
  ativo: boolean;
  diasSemPedido: number;
  naoRepetirAntesDias: number;
  mensagem: string;
  channelSessionId: string | null;
  janelaInicioHora: number;
  janelaFimHora: number;
  recorrencia: "manual" | "diaria" | "semanal";
  diaSemana: number | null;
  horaDisparo: number;
  limitePorRodada: number;
  baseLegal: "consent" | "legitimate_interest";
  liaRef: string | null;
  updatedAt: string;
}

const COLUNAS =
  "organization_id, ativo, dias_sem_pedido, nao_repetir_antes_dias, mensagem, channel_session_id, " +
  "janela_inicio_hora, janela_fim_hora, recorrencia, dia_semana, hora_disparo, limite_por_rodada, " +
  "base_legal, lia_ref, updated_at";

interface LinhaDeConfig {
  organization_id: string;
  ativo: boolean;
  dias_sem_pedido: number;
  nao_repetir_antes_dias: number;
  mensagem: string;
  channel_session_id: string | null;
  janela_inicio_hora: number;
  janela_fim_hora: number;
  recorrencia: "manual" | "diaria" | "semanal";
  dia_semana: number | null;
  hora_disparo: number;
  limite_por_rodada: number;
  base_legal: "consent" | "legitimate_interest";
  lia_ref: string | null;
  updated_at: string;
}

function paraConfig(row: LinhaDeConfig): RecuperacaoConfig {
  return {
    organizationId: row.organization_id,
    ativo: row.ativo,
    diasSemPedido: row.dias_sem_pedido,
    naoRepetirAntesDias: row.nao_repetir_antes_dias,
    mensagem: row.mensagem,
    channelSessionId: row.channel_session_id,
    janelaInicioHora: row.janela_inicio_hora,
    janelaFimHora: row.janela_fim_hora,
    recorrencia: row.recorrencia,
    diaSemana: row.dia_semana,
    horaDisparo: row.hora_disparo,
    limitePorRodada: row.limite_por_rodada,
    baseLegal: row.base_legal,
    liaRef: row.lia_ref,
    updatedAt: row.updated_at,
  };
}

export async function carregarConfig(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RecuperacaoConfig | null> {
  const { data, error } = await admin
    .from("recuperacao_config")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`recuperação: carregar config — ${error.message}`);
  return data ? paraConfig(data as unknown as LinhaDeConfig) : null;
}

/** Configurações ativas cuja hora local de disparo é AGORA — o cron consulta isto. */
export async function organizacoesParaDisparar(
  admin: SupabaseClient,
  hora: number,
  diaSemana: number,
): Promise<string[]> {
  const { data, error } = await admin
    .from("recuperacao_config")
    .select("organization_id")
    .eq("ativo", true)
    .eq("hora_disparo", hora)
    .not("channel_session_id", "is", null)
    .or(`recorrencia.eq.diaria,and(recorrencia.eq.semanal,dia_semana.eq.${diaSemana})`);
  if (error) throw new Error(`recuperação: organizações a disparar — ${error.message}`);
  return (data ?? []).map((r) => (r as { organization_id: string }).organization_id);
}

export async function salvarConfig(
  admin: SupabaseClient,
  organizationId: string,
  entrada: RecuperacaoConfigEntrada,
  updatedBy: string,
): Promise<RecuperacaoConfig> {
  const { data, error } = await admin
    .from("recuperacao_config")
    .upsert(
      {
        organization_id: organizationId,
        ativo: entrada.ativo,
        dias_sem_pedido: entrada.dias_sem_pedido,
        nao_repetir_antes_dias: entrada.nao_repetir_antes_dias,
        mensagem: entrada.mensagem,
        channel_session_id: entrada.channel_session_id,
        janela_inicio_hora: entrada.janela_inicio_hora,
        janela_fim_hora: entrada.janela_fim_hora,
        recorrencia: entrada.recorrencia,
        dia_semana: entrada.dia_semana ?? null,
        hora_disparo: entrada.hora_disparo,
        limite_por_rodada: entrada.limite_por_rodada,
        base_legal: entrada.base_legal,
        lia_ref: entrada.lia_ref ?? null,
        updated_by: updatedBy,
      },
      { onConflict: "organization_id" },
    )
    .select(COLUNAS)
    .single();
  if (error || !data) throw new Error(`recuperação: salvar config — ${error?.message ?? "sem retorno"}`);
  return paraConfig(data as unknown as LinhaDeConfig);
}
