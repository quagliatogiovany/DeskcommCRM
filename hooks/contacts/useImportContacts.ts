/**
 * useImportContacts — POST multipart do CSV para /api/v1/contacts/import.
 *
 * Usa fetch cru (não o apiClient) porque o client serializa body como JSON e
 * não fala FormData — mesmo padrão de hooks/ai/useSkills.ts. Erro é sempre
 * ApiError para o diálogo mostrar `message` direto no toast.
 *
 * O arquivo é dividido no navegador em partes de até 500 linhas (o limite do servidor por pedido) e enviado uma
 * parte de cada vez; os resumos são somados e o número da linha de cada erro volta a ser o do ARQUIVO.
 */
import { ApiError } from "@/lib/api/types";
import type { ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { analisarArquivo, type ParteDoArquivo } from "@/lib/contacts/importar-em-partes";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export interface ImportContactsResult {
  total_linhas: number;
  imported: number;
  skipped_duplicates: number;
  errors: Array<{ linha: number; motivo: string }>;
  /** Preenchido quando uma parte falhou no meio: as anteriores JÁ foram importadas. */
  interrompido?: { aPartirDaLinha: number; motivo: string };
}

export interface ImportContactsInput {
  file: File;
  /** Etiqueta aplicada a toda pessoa nova desta importação. */
  etiqueta?: string;
  onProgresso?: (parteAtual: number, totalDePartes: number) => void;
}

async function enviarParte(csv: string, nomeDoArquivo: string, etiqueta: string): Promise<ImportContactsResult> {
  const form = new FormData();
  form.append("file", new File([csv], nomeDoArquivo, { type: "text/csv" }));
  if (etiqueta) form.append("etiqueta", etiqueta);
  const res = await fetch("/api/v1/contacts/import", {
    method: "POST",
    headers: { "Idempotency-Key": randomId() },
    body: form,
    credentials: "same-origin",
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const errBody = parsed as ApiErrorBody | null;
    const e = errBody?.error;
    throw new ApiError(
      res.status,
      e?.code ?? "unknown_error",
      e?.details,
      e?.request_id ?? randomId(),
      e?.message,
    );
  }
  return (parsed as { data: ImportContactsResult }).data;
}

/** Manda o arquivo inteiro num pedido só: quando não deu para dividir, o servidor explica o que está errado. */
async function importarSemDividir({ file, etiqueta = "" }: ImportContactsInput): Promise<ImportContactsResult> {
  return enviarParte(await file.text(), file.name, etiqueta);
}

export async function importarCsv(input: ImportContactsInput): Promise<ImportContactsResult> {
  const { file, etiqueta = "", onProgresso } = input;
  const analise = await analisarArquivo(file);
  if (analise !== null && "erro" in analise) throw new Error(analise.erro);
  if (analise === null) return importarSemDividir(input);
  if (analise.excedeOTeto) throw new Error("Máximo de 5.000 contatos por importação — divida a planilha.");

  const total: ImportContactsResult = { total_linhas: 0, imported: 0, skipped_duplicates: 0, errors: [] };
  const partes: ParteDoArquivo[] = analise.partes;
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i]!;
    onProgresso?.(i + 1, partes.length);
    try {
      const r = await enviarParte(parte.csv, file.name, etiqueta);
      total.total_linhas += r.total_linhas;
      total.imported += r.imported;
      total.skipped_duplicates += r.skipped_duplicates;
      for (const e of r.errors) total.errors.push({ linha: e.linha + parte.deslocamentoDeLinha, motivo: e.motivo });
    } catch (err) {
      // A 1ª parte falhando é erro do arquivo/permissão: sobe como antes. Depois dela já há gente importada —
      // então devolve o que foi feito e diz de onde retomar, em vez de jogar tudo fora com um toast.
      if (i === 0) throw err;
      const aPartirDaLinha = 2 + (analise.semCabecalho ? -1 : 0) + partes.slice(0, i).reduce((s, p) => s + p.linhas, 0);
      total.interrompido = {
        aPartirDaLinha,
        motivo: err instanceof Error && err.message ? err.message : "falha de conexão",
      };
      break;
    }
  }
  return total;
}

export function useImportContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: importarCsv,
    onSettled: () => {
      // A lista pode ter crescido em qualquer página/filtro — invalida tudo (mesmo se uma parte falhou no meio).
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

