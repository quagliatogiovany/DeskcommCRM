/**
 * Heatmap de quando o lead entra em contato (dia da semana × hora) — shape cru
 * devolvido por `fn_leads_por_horario` (migration 0560) e as funções puras que
 * a tela usa para desenhá-lo.
 *
 * A função SQL só devolve os baldes com dado; `gradeCompleta` preenche os 168
 * (7×24) com `leads: 0` explícito — a tela não decide "faltou" por ausência de
 * chave no array, ela lê uma grade sempre do mesmo tamanho.
 */

export { formatarDuracao } from "./atrito";

export interface CelulaGradeRaw {
  dow: number;
  hora: number;
  leads: number;
  respondidos: number;
  sem_resposta: number;
}

export interface PorHoraRaw {
  hora: number;
  leads: number;
  p50_resposta_ia_s: number | null;
  p50_resposta_humano_s: number | null;
  sem_resposta: number;
}

export interface LeadsPorHorarioRaw {
  timezone: string;
  grade: CelulaGradeRaw[];
  por_hora: PorHoraRaw[];
}

/** isodow: 1 = segunda … 7 = domingo. */
export const DIAS_DA_SEMANA = [
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
  "Domingo",
] as const;

/**
 * Todos os 168 baldes, em ordem (dow 1→7, hora 0→23), com zero explícito onde
 * `fn_leads_por_horario` não devolveu linha — nunca `undefined`.
 */
export function gradeCompleta(bruta: CelulaGradeRaw[]): CelulaGradeRaw[] {
  const porChave = new Map(bruta.map((c) => [`${c.dow}:${c.hora}`, c]));
  const completa: CelulaGradeRaw[] = [];
  for (let dow = 1; dow <= 7; dow++) {
    for (let hora = 0; hora < 24; hora++) {
      const existente = porChave.get(`${dow}:${hora}`);
      completa.push(existente ?? { dow, hora, leads: 0, respondidos: 0, sem_resposta: 0 });
    }
  }
  return completa;
}

/**
 * Intensidade 0–1 para a cor da célula. `0` quando não há máximo (grade
 * vazia) — nunca `NaN`, que quebraria o `style` inline da tela.
 */
export function intensidade(leads: number, maximo: number): number {
  if (maximo <= 0) return 0;
  return Math.min(1, leads / maximo);
}

/** Maior contagem de leads na grade — base da escala de cor. `0` se vazia. */
export function maiorContagem(grade: CelulaGradeRaw[]): number {
  return grade.reduce((acc, c) => Math.max(acc, c.leads), 0);
}

/**
 * % respondido (IA ou humano) sobre o total do balde. `null` sem dado — a
 * tela mostra "—", nunca "0%" para um horário em que nenhum lead chegou.
 */
export function taxaDeResposta(c: CelulaGradeRaw): number | null {
  if (c.leads <= 0) return null;
  return c.respondidos / c.leads;
}
