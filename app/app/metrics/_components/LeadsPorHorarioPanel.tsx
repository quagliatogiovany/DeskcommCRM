"use client";

import { Fragment } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useLeadsPorHorario } from "@/hooks/metrics/useLeadsPorHorario";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DIAS_DA_SEMANA,
  formatarDuracao,
  gradeCompleta,
  intensidade,
  maiorContagem,
  taxaDeResposta,
} from "@/lib/metrics/leads-por-horario";

const HORAS = Array.from({ length: 24 }, (_, h) => h);

export function LeadsPorHorarioPanel() {
  const t = useT();
  const { data, isLoading, isError } = useLeadsPorHorario();

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data)
    return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;

  const { grade: bruta, por_hora: porHora, timezone } = data.data;
  const grade = gradeCompleta(bruta);
  const maximo = maiorContagem(grade);
  const porHoraPorHora = new Map(porHora.map((p) => [p.hora, p]));
  const celulaPorChave = new Map(grade.map((c) => [`${c.dow}:${c.hora}`, c]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("Quando o lead entra em contato")}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("1ª mensagem de cada conversa, por dia e hora")} · {t("fuso")} {timezone}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 overflow-x-auto">
        {maximo === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Sem conversa iniciada por cliente no período.")}
          </p>
        ) : (
          <div className="grid min-w-[720px] grid-cols-[3rem_repeat(24,1fr)] gap-[2px] text-xs">
            <div />
            {HORAS.map((h) => (
              <div key={h} className="text-center text-muted-foreground">
                {h}
              </div>
            ))}
            {DIAS_DA_SEMANA.map((rotuloDia, idx) => {
              const dow = idx + 1;
              return (
                <Fragment key={`dia-${dow}`}>
                  <div className="flex items-center text-muted-foreground">
                    {rotuloDia.slice(0, 3)}
                  </div>
                  {HORAS.map((hora) => {
                    const celula = celulaPorChave.get(`${dow}:${hora}`)!;
                    const alpha = intensidade(celula.leads, maximo);
                    const taxa = taxaDeResposta(celula);
                    const titulo =
                      celula.leads === 0
                        ? t("Nenhum lead chegou neste horário")
                        : `${celula.leads} ${celula.leads === 1 ? t("lead") : t("leads")} · ${
                            taxa === null ? "—" : `${Math.round(taxa * 100)}% ${t("respondidos")}`
                          }`;
                    return (
                      <div
                        key={`${dow}:${hora}`}
                        title={titulo}
                        className="aspect-square rounded-sm"
                        style={{
                          backgroundColor:
                            alpha === 0 ? "var(--muted)" : `color-mix(in oklch, var(--primary) ${Math.round(alpha * 100)}%, var(--muted))`,
                        }}
                      />
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        )}

        {porHora.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("1ª resposta por hora do dia")}</p>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {HORAS.map((h) => {
                const p = porHoraPorHora.get(h);
                if (!p || p.leads === 0) return null;
                return (
                  <span key={h} className="rounded-md border px-2 py-1">
                    {h}h · {t("IA")} {formatarDuracao0(p.p50_resposta_ia_s)} · {t("humano")}{" "}
                    {formatarDuracao0(p.p50_resposta_humano_s)}
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatarDuracao0(segundos: number | null): string {
  return segundos === null ? "—" : formatarDuracao(segundos);
}
