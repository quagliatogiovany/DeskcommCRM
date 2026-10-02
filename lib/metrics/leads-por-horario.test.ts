import { describe, expect, it } from "vitest";

import {
  type CelulaGradeRaw,
  gradeCompleta,
  intensidade,
  maiorContagem,
  taxaDeResposta,
} from "./leads-por-horario";

describe("gradeCompleta", () => {
  it("devolve os 168 baldes mesmo sem nenhum dado", () => {
    const grade = gradeCompleta([]);
    expect(grade).toHaveLength(7 * 24);
    expect(grade.every((c) => c.leads === 0)).toBe(true);
  });

  it("preserva o balde existente e zera só os ausentes", () => {
    const grade = gradeCompleta([{ dow: 3, hora: 14, leads: 5, respondidos: 4, sem_resposta: 1 }]);
    const terca14h = grade.find((c) => c.dow === 3 && c.hora === 14);
    expect(terca14h).toEqual({ dow: 3, hora: 14, leads: 5, respondidos: 4, sem_resposta: 1 });
    expect(grade.filter((c) => c.leads > 0)).toHaveLength(1);
  });

  it("ordena dow 1→7 e hora 0→23", () => {
    const grade = gradeCompleta([]);
    expect(grade[0]).toMatchObject({ dow: 1, hora: 0 });
    expect(grade.at(-1)).toMatchObject({ dow: 7, hora: 23 });
  });
});

describe("intensidade", () => {
  it("é 0 quando não há máximo (grade vazia)", () => {
    expect(intensidade(0, 0)).toBe(0);
  });

  it("escala linearmente até o máximo", () => {
    expect(intensidade(5, 10)).toBe(0.5);
    expect(intensidade(10, 10)).toBe(1);
  });

  it("nunca passa de 1", () => {
    expect(intensidade(15, 10)).toBe(1);
  });
});

describe("maiorContagem", () => {
  it("é 0 numa grade vazia", () => {
    expect(maiorContagem([])).toBe(0);
  });

  it("acha o maior leads da grade", () => {
    const grade: CelulaGradeRaw[] = [
      { dow: 1, hora: 9, leads: 3, respondidos: 3, sem_resposta: 0 },
      { dow: 2, hora: 14, leads: 7, respondidos: 2, sem_resposta: 5 },
    ];
    expect(maiorContagem(grade)).toBe(7);
  });
});

describe("taxaDeResposta", () => {
  it("é null quando nenhum lead chegou no balde (não é 0%)", () => {
    expect(taxaDeResposta({ dow: 1, hora: 3, leads: 0, respondidos: 0, sem_resposta: 0 })).toBeNull();
  });

  it("calcula a razão quando há leads", () => {
    expect(taxaDeResposta({ dow: 1, hora: 9, leads: 4, respondidos: 3, sem_resposta: 1 })).toBe(0.75);
  });
});
