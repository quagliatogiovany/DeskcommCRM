import { describe, expect, it } from "vitest";

import { CSV_MAX_DATA_ROWS, parseCsv } from "./csv";
import {
  dividirEmPartes,
  IMPORTACAO_MAX_CONTATOS,
  PLANILHA_DE_EXEMPLO,
  serializarCsv,
} from "./importar-em-partes";

const pessoas = (n: number): string[][] =>
  Array.from({ length: n }, (_, i) => [`Pessoa ${i + 1}`, `4899${String(i).padStart(7, "0")}`]);

describe("dividirEmPartes", () => {
  it("1.200 pessoas com cabeçalho viram 3 partes (500 + 500 + 200), todas com o mesmo cabeçalho", () => {
    const r = dividirEmPartes([["nome", "telefone"], ...pessoas(1200)])!;
    expect(r.totalDeLinhas).toBe(1200);
    expect(r.partes.map((p) => p.linhas)).toEqual([500, 500, 200]);
    expect(r.semCabecalho).toBe(false);
    for (const p of r.partes) expect(parseCsv(p.csv)[0]).toEqual(["nome", "telefone"]);
    expect(r.excedeOTeto).toBe(false);
  });

  it("cada parte respeita o limite do servidor por pedido", () => {
    const r = dividirEmPartes([["nome", "telefone"], ...pessoas(1700)])!;
    for (const p of r.partes) expect(p.linhas).toBeLessThanOrEqual(CSV_MAX_DATA_ROWS);
    // nada se perde nem se repete: as pessoas das partes, em ordem, são as do arquivo
    const juntas = r.partes.flatMap((p) => parseCsv(p.csv).slice(1));
    expect(juntas).toEqual(pessoas(1700));
  });

  it("o número de linha de erro volta a ser o do ARQUIVO: servidor numera cada parte a partir do cabeçalho", () => {
    const r = dividirEmPartes([["nome", "telefone"], ...pessoas(1200)])!;
    // 1ª pessoa da 2ª parte é a linha 502 do arquivo (cabeçalho = 1); o servidor a chama de linha 2
    expect(2 + r.partes[1]!.deslocamentoDeLinha).toBe(502);
    expect(2 + r.partes[2]!.deslocamentoDeLinha).toBe(1002);
    expect(2 + r.partes[0]!.deslocamentoDeLinha).toBe(2);
  });

  it("arquivo SEM cabeçalho: monta um, e a 1ª pessoa é a linha 1 do arquivo", () => {
    const r = dividirEmPartes(pessoas(600))!;
    expect(r.semCabecalho).toBe(true);
    expect(r.totalDeLinhas).toBe(600);
    expect(r.partes.map((p) => p.linhas)).toEqual([500, 100]);
    expect(parseCsv(r.partes[0]!.csv)[0]).toEqual(["nome", "telefone"]);
    expect(parseCsv(r.partes[0]!.csv)[1]).toEqual(["Pessoa 1", "48990000000"]);
    expect(2 + r.partes[0]!.deslocamentoDeLinha).toBe(1); // a 1ª pessoa ocupa a linha 1
    expect(2 + r.partes[1]!.deslocamentoDeLinha).toBe(501); // 501ª pessoa = linha 501
  });

  it("sem cabeçalho e com o telefone na primeira coluna", () => {
    const r = dividirEmPartes([["48999990000", "Maria"], ["48988881111", "João"]])!;
    expect(parseCsv(r.partes[0]!.csv)).toEqual([
      ["telefone", "nome"],
      ["48999990000", "Maria"],
      ["48988881111", "João"],
    ]);
  });

  it("mais que o teto: avisa, para a tela travar o botão", () => {
    expect(dividirEmPartes([["nome", "telefone"], ...pessoas(IMPORTACAO_MAX_CONTATOS)])!.excedeOTeto).toBe(false);
    expect(dividirEmPartes([["nome", "telefone"], ...pessoas(IMPORTACAO_MAX_CONTATOS + 1)])!.excedeOTeto).toBe(true);
  });

  it("não dá para saber as colunas: devolve null e o servidor explica", () => {
    expect(dividirEmPartes([["Cidade", "Estado"], ["Floripa", "SC"]])).toBeNull();
    expect(dividirEmPartes([])).toBeNull();
  });

  it("só o cabeçalho, sem ninguém: nenhuma parte", () => {
    expect(dividirEmPartes([["nome", "telefone"]])!.partes).toEqual([]);
  });
});

describe("serializarCsv", () => {
  it("vai e volta pelo parseCsv, com vírgula, aspas e quebra de linha dentro do campo", () => {
    const linhas = [["nome", "obs"], ["Silva, Maria", 'disse "oi"'], ["João", "linha1\nlinha2"], [" espaço ", "x"]];
    expect(parseCsv(serializarCsv(linhas))).toEqual(linhas);
  });
});

describe("PLANILHA_DE_EXEMPLO", () => {
  it("é um CSV UTF-8 com BOM, cabeçalho nome,telefone e pessoas de exemplo que o próprio sistema entende", () => {
    expect(PLANILHA_DE_EXEMPLO.startsWith("﻿")).toBe(true);
    const r = dividirEmPartes(parseCsv(PLANILHA_DE_EXEMPLO))!;
    expect(r.semCabecalho).toBe(false);
    expect(r.totalDeLinhas).toBe(3);
  });
});
