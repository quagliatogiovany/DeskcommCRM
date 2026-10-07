"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useImportContacts } from "@/hooks/contacts/useImportContacts";
import {
  analisarArquivo,
  IMPORTACAO_MAX_CONTATOS,
  PLANILHA_DE_EXEMPLO,
  type ArquivoAnalisado,
} from "@/lib/contacts/importar-em-partes";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** O que a tela sabe do arquivo escolhido, antes de importar. */
type Leitura = ArquivoAnalisado | { erro: string } | "nao-reconhecido" | null;

function comoAnalise(l: Leitura): ArquivoAnalisado | null {
  return l !== null && typeof l === "object" && "partes" in l ? l : null;
}

function comoErro(l: Leitura): string | null {
  return l !== null && typeof l === "object" && "erro" in l ? l.erro : null;
}

function baixarPlanilhaDeExemplo() {
  const url = URL.createObjectURL(new Blob([PLANILHA_DE_EXEMPLO], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "modelo-contatos.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Diálogo de importação de contatos por CSV. O resumo é mostrado NO diálogo
 * (e não só em toast) porque erros por linha são a parte que interessa —
 * fechar sozinho esconderia o que o usuário veio corrigir na planilha.
 *
 * O arquivo é dividido em partes de 500 no navegador (ver `lib/contacts/importar-em-partes.ts`): a pessoa escolhe
 * UM arquivo de até 5.000 contatos e vê o andamento, sem dividir nada à mão.
 */
export function ImportContactsDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const importar = useImportContacts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [leitura, setLeitura] = useState<Leitura>(null);
  const [etiqueta, setEtiqueta] = useState("");
  const [andamento, setAndamento] = useState<{ atual: number; total: number } | null>(null);
  const [resumo, setResumo] = useState<Awaited<ReturnType<typeof importar.mutateAsync>> | null>(null);

  function reset() {
    setFile(null);
    setLeitura(null);
    setEtiqueta("");
    setAndamento(null);
    setResumo(null);
  }

  async function escolherArquivo(f: File | null) {
    setFile(f);
    setLeitura(null);
    if (!f) return;
    try {
      setLeitura((await analisarArquivo(f)) ?? "nao-reconhecido");
    } catch {
      setLeitura("nao-reconhecido");
    }
  }

  const analisado = comoAnalise(leitura);
  const erroDoArquivo = comoErro(leitura);
  const passaDoTeto = analisado?.excedeOTeto ?? false;
  const arquivoRecusado = erroDoArquivo !== null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || importar.isPending || passaDoTeto || arquivoRecusado) return;
    try {
      const r = await importar.mutateAsync({
        file,
        etiqueta,
        onProgresso: (atual, total) => setAndamento({ atual, total }),
      });
      setResumo(r);
      if (r.imported > 0) toast.success(`${r.imported} ${t("contato(s) importado(s)")}`);
      if (r.errors.length > 0) toast.warning(`${r.errors.length} ${t("linha(s) com problema")}`);
    } catch (err) {
      // Falha de requisição (arquivo grande, formato errado…): mostra no rodapé.
      const msg =
        err instanceof Error && err.message
          ? t(err.message)
          : t("Não foi possível importar o arquivo.");
      toast.error(msg);
    } finally {
      setAndamento(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Importar contatos de planilha")}</DialogTitle>
          <DialogDescription>
            {t(
              "Envie um arquivo .csv — colunas reconhecidas: nome, telefone, email, cpf, nascimento, tags. Excel: use “Salvar como” → “CSV UTF-8”.",
            )}{" "}
            {t("Só nome e telefone? Funciona, com ou sem a linha de cabeçalho.")}{" "}
            {t("Até 5.000 contatos por importação: o sistema envia em partes sozinho.")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {!resumo && (
            <>
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={baixarPlanilhaDeExemplo}>
                {t("Baixar planilha de exemplo")}
              </Button>

              <div className="space-y-2">
                <Label htmlFor="csv-file">{t("Arquivo CSV")}</Label>
                <Input
                  id="csv-file"
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void escolherArquivo(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <p className="text-xs text-muted-foreground">
                    {file.name} · {(file.size / 1024).toFixed(1)} KB
                  </p>
                )}
                {erroDoArquivo !== null && <p className="text-sm text-error-fg">{erroDoArquivo}</p>}
                {analisado && !passaDoTeto && (
                  <p className="text-sm">
                    {analisado.totalDeLinhas} {t("pessoa(s) encontrada(s)")}
                    {analisado.partes.length > 1 &&
                      ` · ${t("será enviado em")} ${analisado.partes.length} ${t("partes")}`}
                  </p>
                )}
                {passaDoTeto && (
                  <p className="text-sm text-error-fg">
                    {t("Máximo de")} {IMPORTACAO_MAX_CONTATOS.toLocaleString("pt-BR")}{" "}
                    {t("contatos por importação — divida a planilha.")}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="csv-etiqueta">{t("Etiqueta para esta lista (opcional)")}</Label>
                <Input
                  id="csv-etiqueta"
                  value={etiqueta}
                  maxLength={40}
                  placeholder="recuperacao-2026"
                  onChange={(e) => setEtiqueta(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Toda pessoa nova desta importação recebe essa etiqueta. Depois, filtre a campanha por ela. Quem já estava cadastrado não recebe.")}
                </p>
              </div>

              {andamento && andamento.total > 1 && (
                <p className="text-sm" role="status">
                  {t("Importando parte")} {andamento.atual} {t("de")} {andamento.total}…
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={importar.isPending}
                >
                  {t("Cancelar")}
                </Button>
                <Button type="submit" disabled={!file || importar.isPending || passaDoTeto || arquivoRecusado}>
                  {importar.isPending ? t("Importando…") : t("Importar")}
                </Button>
              </DialogFooter>
            </>
          )}

          {resumo && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="rounded-md bg-surface px-2 py-1">
                  {resumo.total_linhas} {t("linha(s) lidas")}
                </span>
                <span className="rounded-md px-2 py-1 font-medium">
                  {resumo.imported} {t("importado(s)")}
                </span>
                {resumo.skipped_duplicates > 0 && (
                  <span className="rounded-md bg-surface px-2 py-1">
                    {resumo.skipped_duplicates} {t("já existente(s)")}
                  </span>
                )}
                {resumo.errors.length > 0 && (
                  <span className="rounded-md px-2 py-1 font-medium">
                    {resumo.errors.length} {t("com erro")}
                  </span>
                )}
              </div>

              {resumo.interrompido && (
                <p className="rounded-md border border-border p-2 text-sm" role="alert">
                  {t("A importação parou na linha")} {resumo.interrompido.aPartirDaLinha}: {resumo.interrompido.motivo}.{" "}
                  {t("O que veio antes já foi importado. Envie de novo só as linhas a partir daí.")}
                </p>
              )}

              {resumo.errors.length > 0 && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
                  {resumo.errors.map((err) => (
                    <p key={`${err.linha}-${err.motivo}`}>
                      {t("Linha")} {err.linha}: {err.motivo}
                    </p>
                  ))}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={reset}>
                  {t("Importar outro arquivo")}
                </Button>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  {t("Concluir")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
