"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CelulaGradeRaw, PorHoraRaw } from "@/lib/metrics/leads-por-horario";

export interface LeadsPorHorarioResponse {
  window: { from: string; to: string };
  timezone: string;
  grade: CelulaGradeRaw[];
  por_hora: PorHoraRaw[];
}

/** migration 0560 — heatmap de dia-da-semana × hora em que o lead chega. */
export function useLeadsPorHorario() {
  return useQuery({
    queryKey: ["metrics", "leads-por-horario"],
    queryFn: async () =>
      apiClient.get<{ data: LeadsPorHorarioResponse }>("/api/v1/metrics/leads-por-horario"),
    staleTime: 30_000,
  });
}
