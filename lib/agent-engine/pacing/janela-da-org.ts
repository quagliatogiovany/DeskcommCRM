/**
 * Janela de RESPOSTA definida para a ORGANIZAÇÃO inteira (`organizations.settings.janela_resposta`).
 *
 * Quem grava é o Nodus (`PATCH /api/internal/provisioning/org`): a loja escolhe uma vez "quando a
 * atendente responde" e isso vale para todos os números dela, sem o dono abrir o Anti-ban de cada
 * canal. Precedência na leitura (`loadChannelKnobs`): o que o operador gravou no NÚMERO
 * (`channel_knobs.resposta_*`) > a janela da organização > a janela de disparo > o default.
 * Quem mexe no canal continua mandando no canal.
 *
 * `settings` é jsonb livre: leitura defensiva. Valor torto = sem janela da org (cai no próximo
 * degrau), nunca uma mordaça.
 */
export interface JanelaDaOrg {
  startHour: number;
  endHour: number;
}

export function janelaDeRespostaDaOrg(settings: unknown): JanelaDaOrg | null {
  const bruto = (settings as { janela_resposta?: unknown } | null)?.janela_resposta;
  if (typeof bruto !== 'object' || bruto === null) return null;
  const { start_hour: startHour, end_hour: endHour } = bruto as { start_hour?: unknown; end_hour?: unknown };
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null;
  const s = startHour as number;
  const e = endHour as number;
  if (s < 0 || s > 23 || e < 1 || e > 24 || s >= e) return null;
  return { startHour: s, endHour: e };
}
