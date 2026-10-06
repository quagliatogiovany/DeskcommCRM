"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/** O exemplo é texto que vai para o cliente final (brasileiro): fica em português, sem `t()`. */
export const EXEMPLO_DE_VARIANTES = `Oi {{primeiro_nome}}! Sentimos sua falta por aqui.
---
Olá {{primeiro_nome}}, faz um tempinho que você não pede.
---
Ei {{primeiro_nome}}! Que tal pedir hoje?`;

/**
 * Como mandar textos diferentes para cada pessoa. A regra mora em `escolherVariante`
 * (`lib/campanhas/renderizador.ts`): uma linha só de traços separa as versões.
 */
export function DicaDeVariantes({ onUsarExemplo }: { onUsarExemplo: (texto: string) => void }) {
  const t = useT();
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{t("Quer mandar textos diferentes para cada pessoa?")}</p>
      <p>
        {t(
          "Escreva as versões uma embaixo da outra e coloque entre elas uma linha com só três traços (---). Cada cliente recebe uma versão sorteada.",
        )}
      </p>
      <pre className="whitespace-pre-wrap rounded-md bg-surface-elevated p-2 font-mono text-xs text-foreground">
        {EXEMPLO_DE_VARIANTES}
      </pre>
      <p>{t("Atenção: apertar Enter não separa as versões, só pula linha dentro da mesma mensagem. O que separa é a linha com os três traços, sozinha. Sem ela, todos recebem o texto inteiro.")}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => onUsarExemplo(EXEMPLO_DE_VARIANTES)}>
        {t("Usar este exemplo")}
      </Button>
    </div>
  );
}
