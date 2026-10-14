"use client";
/**
 * Hora cheia do envio, escolhida numa lista — nunca digitada.
 *
 * Campo numérico aceitava 25, 40, 98: o servidor recusava, mas só depois de
 * salvar, e "1" não dizia se era 1h da manhã ou 13h. A lista só tem horas que
 * existem, com o relógio de 24h escrito por extenso (08:00, 13:00, 20:00).
 *
 * O INÍCIO vai de 00:00 a 23:00; o FIM de 01:00 a 24:00 (24:00 = meia-noite, o
 * fim do dia). Vazio = herda o ritmo do número.
 */
import { useT } from "@/hooks/i18n/useT";

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function SeletorDeHora({
  id,
  rotulo,
  tipo,
  valor,
  onChange,
}: {
  id: string;
  rotulo: string;
  tipo: "inicio" | "fim";
  /** Hora cheia como texto ("13"), ou "" para o padrão do número. */
  valor: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const horas = tipo === "inicio" ? Array.from({ length: 24 }, (_, i) => i) : Array.from({ length: 24 }, (_, i) => i + 1);
  const exemplo = tipo === "inicio" ? t("Ex.: 08:00 — começa às 8 da manhã") : t("Ex.: 20:00 — para às 8 da noite");
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        {rotulo}
      </label>
      <select
        id={id}
        className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("Padrão do número")}</option>
        {horas.map((h) => (
          <option key={h} value={String(h)}>
            {rotuloDaHora(h, t)}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{exemplo}</p>
    </div>
  );
}

function rotuloDaHora(h: number, t: (s: string) => string): string {
  if (h === 0) return `00:00 (${t("meia-noite")})`;
  if (h === 24) return `24:00 (${t("fim do dia, meia-noite")})`;
  if (h === 12) return `12:00 (${t("meio-dia")})`;
  return h < 12 ? `${hh(h)} (${t("manhã")})` : h < 18 ? `${hh(h)} (${t("tarde")})` : `${hh(h)} (${t("noite")})`;
}

/** Mensagem quando o fim não vem depois do início; vazio quando está tudo certo. */
export function erroDaJanela(inicio: string, fim: string, t: (s: string) => string): string {
  if (inicio === "" || fim === "") {
    return inicio === fim ? "" : t("Preencha o início e o fim, ou deixe os dois no padrão do número.");
  }
  return Number(fim) > Number(inicio) ? "" : t("O fim precisa ser depois do início (o envio não atravessa a meia-noite).");
}
