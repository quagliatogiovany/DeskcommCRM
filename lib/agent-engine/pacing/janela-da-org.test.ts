import { describe, expect, it } from 'vitest';

import { janelaDeRespostaDaOrg } from './janela-da-org';

describe('janelaDeRespostaDaOrg', () => {
  it('lê a janela gravada pelo Nodus (0–24 = qualquer hora)', () => {
    expect(janelaDeRespostaDaOrg({ janela_resposta: { start_hour: 0, end_hour: 24 } })).toEqual({
      startHour: 0,
      endHour: 24,
    });
  });

  it('sem configuração ou com valor torto devolve null (cai no próximo degrau, nunca vira mordaça)', () => {
    for (const s of [
      null,
      {},
      { janela_resposta: null },
      { janela_resposta: { start_hour: 22, end_hour: 7 } },
      { janela_resposta: { start_hour: 5, end_hour: 5 } },
      { janela_resposta: { start_hour: -1, end_hour: 10 } },
      { janela_resposta: { start_hour: 0, end_hour: 25 } },
      { janela_resposta: { start_hour: '7', end_hour: 22 } },
      { janela_resposta: { start_hour: 7.5, end_hour: 22 } },
    ]) {
      expect(janelaDeRespostaDaOrg(s)).toBeNull();
    }
  });
});
