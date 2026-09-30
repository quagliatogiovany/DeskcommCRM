"use client";
/**
 * A configuração e as ações da tela Campanhas → Recuperação.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface RecuperacaoConfig {
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
  updated_at?: string;
}

export interface PreviaDaRecuperacao {
  total_inativos: number;
  elegiveis: number;
  excluidos_por_cooldown: number;
  amostra: Array<{ nome: string | null; dias_sem_pedir: number }>;
}

const CHAVE_CONFIG = ["recuperacao", "config"] as const;

export function useRecuperacaoConfig() {
  return useQuery({
    queryKey: CHAVE_CONFIG,
    queryFn: async () => (await apiClient.get<{ data: RecuperacaoConfig }>("/api/v1/recuperacao/config")).data,
  });
}

export function useSalvarRecuperacaoConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: Omit<RecuperacaoConfig, "organization_id" | "updated_at">) =>
      (await apiClient.put<{ data: RecuperacaoConfig }>("/api/v1/recuperacao/config", corpo)).data,
    onSuccess: (data) => queryClient.setQueryData(CHAVE_CONFIG, data),
  });
}

export function usePreviaDaRecuperacao(diasSemPedido: number, naoRepetirAntesDias: number) {
  return useQuery({
    queryKey: ["recuperacao", "previa", diasSemPedido, naoRepetirAntesDias],
    queryFn: async () => {
      const qs = new URLSearchParams({
        dias_sem_pedido: String(diasSemPedido),
        nao_repetir_antes_dias: String(naoRepetirAntesDias),
      });
      return (
        await apiClient.get<{ data: PreviaDaRecuperacao }>(`/api/v1/recuperacao/previa?${qs}`)
      ).data;
    },
    enabled: diasSemPedido > 0 && naoRepetirAntesDias > 0,
  });
}

export function useDispararRecuperacao() {
  return useMutation({
    mutationFn: async () =>
      (
        await apiClient.post<{ data: { campanha_id: string; total: number; elegiveis: number } }>(
          "/api/v1/recuperacao/disparar",
          {},
        )
      ).data,
  });
}
