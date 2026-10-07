/**
 * Importação de contatos em PARTES, do lado do navegador.
 *
 * A rota `POST /api/v1/contacts/import` aceita no máximo `CSV_MAX_DATA_ROWS` linhas por pedido (insere linha a
 * linha, e um pedido longo demais estoura). Em vez de obrigar a pessoa a dividir a planilha à mão, o navegador
 * lê o arquivo, divide em partes de até esse tamanho e manda uma de cada vez. Cada parte leva o MESMO cabeçalho,
 * então o servidor trata todas igual.
 *
 * Puro de propósito (sem fetch, sem React): é aqui que mora a conta de linhas, e é o que os testes cobrem.
 */
import {
  CSV_MAX_DATA_ROWS,
  decodificarCsv,
  inferirSemCabecalho,
  mapHeader,
  parseCsv,
} from "./csv";

/** Teto de contatos por importação, somando as partes. É também o teto do público de uma campanha. */
export const IMPORTACAO_MAX_CONTATOS = 5000;

export interface ParteDoArquivo {
  /** O CSV desta parte, já com cabeçalho. */
  csv: string;
  /** Quantas linhas de dados esta parte tem. */
  linhas: number;
  /**
   * Quanto somar ao número de linha que o servidor devolve nesta parte para chegar à linha do ARQUIVO da pessoa.
   * O servidor numera a partir do cabeçalho da parte (a 1ª pessoa é a linha 2).
   */
  deslocamentoDeLinha: number;
}

export interface ArquivoAnalisado {
  partes: ParteDoArquivo[];
  /** Pessoas no arquivo (sem contar o cabeçalho). */
  totalDeLinhas: number;
  excedeOTeto: boolean;
  /** O arquivo vinha sem linha de cabeçalho (a 1ª linha já era uma pessoa). */
  semCabecalho: boolean;
}

/** Aspas só quando precisa: vírgula, aspas, quebra de linha ou espaço nas pontas. */
function celula(valor: string): string {
  return /[",\r\n]|^\s|\s$/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export function serializarCsv(linhas: string[][]): string {
  return linhas.map((l) => l.map(celula).join(",")).join("\r\n") + "\r\n";
}

/**
 * Divide as linhas do arquivo em partes. `null` quando não dá para saber onde estão as colunas — aí o arquivo
 * vai inteiro num pedido só, e o servidor responde com a mensagem de cabeçalho (que lista as colunas achadas).
 */
export function dividirEmPartes(
  linhas: string[][],
  porParte: number = CSV_MAX_DATA_ROWS,
): ArquivoAnalisado | null {
  if (linhas.length === 0) return null;

  const primeira = linhas[0]!;
  let cabecalho = primeira;
  let dados = linhas.slice(1);
  let semCabecalho = false;

  if (mapHeader(primeira).motivo !== null) {
    const inferido = inferirSemCabecalho(primeira);
    if (!inferido) return null;
    // Arquivo sem cabeçalho: monta um, na largura da linha, para TODA parte ter o mesmo formato.
    semCabecalho = true;
    dados = linhas;
    cabecalho = primeira.map((_, i) =>
      i === inferido.indices.phone_number ? "telefone" : i === inferido.indices.name ? "nome" : "",
    );
  }

  const partes: ParteDoArquivo[] = [];
  for (let inicio = 0; inicio < dados.length; inicio += porParte) {
    const fatia = dados.slice(inicio, inicio + porParte);
    partes.push({
      csv: serializarCsv([cabecalho, ...fatia]),
      linhas: fatia.length,
      // Com cabeçalho no arquivo, a 1ª pessoa é a linha 2 (igual ao servidor); sem cabeçalho, é a linha 1.
      deslocamentoDeLinha: inicio + (semCabecalho ? -1 : 0),
    });
  }

  return { partes, totalDeLinhas: dados.length, excedeOTeto: dados.length > IMPORTACAO_MAX_CONTATOS, semCabecalho };
}

/** Do arquivo escolhido às partes, ou um texto de erro pronto para a tela. */
export async function analisarArquivo(file: File): Promise<ArquivoAnalisado | { erro: string } | null> {
  const bytes = await file.arrayBuffer();
  const decodificado = decodificarCsv(bytes);
  if ("erro" in decodificado) return { erro: decodificado.erro };
  return dividirEmPartes(parseCsv(decodificado.texto));
}

/** A planilha de exemplo que o botão "Baixar planilha de exemplo" entrega. Com BOM, para o Excel abrir os acentos. */
export const PLANILHA_DE_EXEMPLO = "﻿" + serializarCsv([
  ["nome", "telefone"],
  ["Maria Silva", "48999990000"],
  ["João Souza", "(48) 98888-1111"],
  ["Ana Costa", "5548977776666"],
]);
