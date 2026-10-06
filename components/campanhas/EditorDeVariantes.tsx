"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { dividirVariantes, inserirNoCursor, juntarVariantes } from "@/lib/campanhas/renderizador";

/** O que a tela pai alcança: os botões de variável escrevem onde o cursor estava. */
export type EditorDeVariantesHandle = { inserir: (token: string) => void };

/**
 * O texto da campanha, com uma caixa por versão. Quem não quer variar escreve numa caixa só e não vê
 * nada diferente; quem quer, clica em "Adicionar outra versão" — não há regra de traços para aprender.
 * O valor guardado continua sendo UM texto (`juntarVariantes`), o mesmo que o sorteio do envio separa.
 */
export function EditorDeVariantes({
  value,
  onChange,
  rows = 6,
  placeholder,
  ariaLabel,
  ref,
}: {
  value: string;
  onChange: (texto: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
  ref?: Ref<EditorDeVariantesHandle>;
}) {
  const t = useT();
  const versoes = dividirVariantes(value);
  const varias = versoes.length > 1;

  const caixas = useRef<(HTMLTextAreaElement | null)[]>([]);
  // Onde estava o cursor da última caixa mexida. O clique no botão tira o foco da caixa, mas a
  // posição já foi guardada aqui (onSelect/onBlur).
  const cursor = useRef<{ indice: number; inicio: number | null; fim: number | null }>({
    indice: 0,
    inicio: null,
    fim: null,
  });
  const depoisDeInserir = useRef<{ indice: number; posicao: number } | null>(null);

  const guardarCursor = (indice: number, el: HTMLTextAreaElement) => {
    cursor.current = { indice, inicio: el.selectionStart, fim: el.selectionEnd };
  };

  useImperativeHandle(ref, () => ({
    inserir(token) {
      const indice = Math.min(cursor.current.indice, versoes.length - 1);
      const versao = versoes[indice] ?? "";
      const inicio = cursor.current.inicio ?? versao.length;
      const fim = cursor.current.fim ?? inicio;
      const novo = inserirNoCursor(versao, inicio, fim, token);
      depoisDeInserir.current = { indice, posicao: novo.cursor };
      cursor.current = { indice, inicio: novo.cursor, fim: novo.cursor };
      onChange(juntarVariantes(versoes.map((v, j) => (j === indice ? novo.texto : v))));
    },
  }));

  // Devolve o foco e põe o cursor logo depois da variável, para a pessoa seguir digitando.
  useEffect(() => {
    const p = depoisDeInserir.current;
    if (!p) return;
    depoisDeInserir.current = null;
    const el = caixas.current[p.indice];
    el?.focus();
    el?.setSelectionRange(p.posicao, p.posicao);
  });

  const trocar = (i: number, texto: string) => onChange(juntarVariantes(versoes.map((v, j) => (j === i ? texto : v))));
  const remover = (i: number) => onChange(juntarVariantes(versoes.filter((_, j) => j !== i)));

  return (
    <div className="space-y-3">
      {versoes.map((versao, i) => (
        <div key={i} className="space-y-1">
          {varias && (
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t("Versão") + ` ${i + 1}`}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => remover(i)} aria-label={t("Remover esta versão")}>
                <X className="size-4" aria-hidden />
                {t("Remover")}
              </Button>
            </div>
          )}
          <Textarea
            ref={(el) => {
              caixas.current[i] = el;
            }}
            rows={rows}
            value={versao}
            onChange={(e) => trocar(i, e.target.value)}
            onSelect={(e) => guardarCursor(i, e.currentTarget)}
            onBlur={(e) => guardarCursor(i, e.currentTarget)}
            placeholder={i === 0 ? placeholder : undefined}
            aria-label={varias ? `${ariaLabel} ${i + 1}` : ariaLabel}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(juntarVariantes([...versoes, ""]))}>
          <Plus className="size-4" aria-hidden />
          {t("Adicionar outra versão")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {varias
            ? t("Cada cliente recebe uma das versões, sorteada na hora do envio.")
            : t("Quer variar o texto? Adicione outra versão: cada cliente recebe uma, sorteada.")}
        </span>
      </div>
    </div>
  );
}
