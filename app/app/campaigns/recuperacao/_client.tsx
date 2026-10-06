"use client";
/**
 * O formulário de Recuperação. Mesmo padrão de `app/app/campaigns/new/_client.tsx`:
 * seção por seção, prévia ao lado do que decide quem recebe.
 */
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EditorDeVariantes } from "@/components/campanhas/EditorDeVariantes";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import {
  useDispararRecuperacao,
  usePreviaDaRecuperacao,
  useRecuperacaoConfig,
  useSalvarRecuperacaoConfig,
  type RecuperacaoConfig,
} from "@/hooks/recuperacao/useRecuperacao";
import { DESCRICAO_DA_VARIAVEL, VARIAVEIS_DA_CAMPANHA } from "@/lib/campanhas/renderizador";


const HORAS = Array.from({ length: 24 }, (_, h) => h);

function horaLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function RecuperacaoDeClientes() {
  const t = useT();
  const config = useRecuperacaoConfig();

  if (config.isLoading || !config.data) {
    return <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>;
  }

  // `key` no chamador não cabe aqui (não há chamador): o gate acima só monta
  // este componente quando `config.data` já existe, então `useState` abaixo
  // inicializa uma vez só, sem `useEffect` copiando prop pra state.
  return <FormularioDeRecuperacao inicial={config.data} />;
}

function FormularioDeRecuperacao({ inicial }: { inicial: RecuperacaoConfig }) {
  const t = useT();
  const canais = useChannelSessions();
  const salvar = useSalvarRecuperacaoConfig();
  const disparar = useDispararRecuperacao();

  const { organization_id: _org, updated_at: _atualizado, ...resto } = inicial;
  const [estado, setEstado] = useState<Omit<RecuperacaoConfig, "organization_id" | "updated_at">>(resto);

  const previa = usePreviaDaRecuperacao(estado.dias_sem_pedido, estado.nao_repetir_antes_dias);

  const atualizar = <K extends keyof typeof estado>(campo: K, valor: (typeof estado)[K]) => {
    setEstado((atual) => ({ ...atual, [campo]: valor }));
  };

  const podeSalvar = estado.mensagem.trim() !== "" || !estado.ativo;

  const onSalvar = () => {
    salvar.mutate(estado, {
      onSuccess: () => toast.success(t("Configuração salva.")),
      onError: showApiError,
    });
  };

  const onDisparar = () => {
    disparar.mutate(undefined, {
      onSuccess: (r) =>
        toast.success(t("Rodada disparada: {n} de {total} clientes vão receber.")
          .replace("{n}", String(r.elegiveis))
          .replace("{total}", String(r.total))),
      onError: showApiError,
    });
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("Recuperação de clientes")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Convida de volta quem parou de pedir na loja.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={estado.ativo} onCheckedChange={(v) => atualizar("ativo", v)} />
          <span className="text-sm">{estado.ativo ? t("Ativo") : t("Pausado")}</span>
        </div>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-medium">{t("Quem é inativo")}</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t("Dias sem pedir")}</Label>
            <Input
              type="number"
              min={1}
              max={3650}
              value={estado.dias_sem_pedido}
              onChange={(e) => atualizar("dias_sem_pedido", Number(e.target.value) || 1)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("Não repetir antes de (dias)")}</Label>
            <Input
              type="number"
              min={1}
              max={3650}
              value={estado.nao_repetir_antes_dias}
              onChange={(e) => atualizar("nao_repetir_antes_dias", Number(e.target.value) || 1)}
            />
          </div>
        </div>
        {previa.data && (
          <p className="text-sm text-muted-foreground">
            {t("{n} clientes seriam recuperados agora.").replace("{n}", String(previa.data.elegiveis))}
            {previa.data.excluidos_por_cooldown > 0 &&
              ` (${previa.data.excluidos_por_cooldown} ${t("já receberam recentemente")})`}
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-medium">{t("Mensagem")}</h2>
        <EditorDeVariantes
          rows={5}
          value={estado.mensagem}
          onChange={(texto) => atualizar("mensagem", texto)}
          placeholder={t("Sentimos sua falta, {{primeiro_nome}}! Já faz {{dias_sem_pedir}} dias...")}
          ariaLabel={t("Texto da mensagem")}
        />
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {VARIAVEIS_DA_CAMPANHA.map((v) => (
            <span key={v} title={DESCRICAO_DA_VARIAVEL[v]} className="rounded-md bg-muted px-2 py-0.5">
              {`{{${v}}}`}
            </span>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-medium">{t("Envio")}</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t("Conexão de WhatsApp")}</Label>
            <Select
              value={estado.channel_session_id ?? ""}
              onValueChange={(v) => atualizar("channel_session_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("Escolha a conexão")} />
              </SelectTrigger>
              <SelectContent>
                {(canais.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {channelLabel(c, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("Recorrência")}</Label>
            <Select
              value={estado.recorrencia}
              onValueChange={(v) => atualizar("recorrencia", v as RecuperacaoConfig["recorrencia"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">{t("Manual (só o botão Disparar agora)")}</SelectItem>
                <SelectItem value="diaria">{t("Diária")}</SelectItem>
                <SelectItem value="semanal">{t("Semanal")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {estado.recorrencia === "semanal" && (
            <div className="flex flex-col gap-1.5">
              <Label>{t("Dia da semana")}</Label>
              <Select
                value={String(estado.dia_semana ?? 1)}
                onValueChange={(v) => atualizar("dia_semana", Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[t("Domingo"), t("Segunda"), t("Terça"), t("Quarta"), t("Quinta"), t("Sexta"), t("Sábado")].map((nome, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {estado.recorrencia !== "manual" && (
            <div className="flex flex-col gap-1.5">
              <Label>{t("Hora do disparo")}</Label>
              <Select
                value={String(estado.hora_disparo)}
                onValueChange={(v) => atualizar("hora_disparo", Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HORAS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {horaLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>{t("Janela de envio — início")}</Label>
            <Select
              value={String(estado.janela_inicio_hora)}
              onValueChange={(v) => atualizar("janela_inicio_hora", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORAS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {horaLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("Janela de envio — fim")}</Label>
            <Select
              value={String(estado.janela_fim_hora)}
              onValueChange={(v) => atualizar("janela_fim_hora", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORAS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {horaLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("Limite por rodada")}</Label>
            <Input
              type="number"
              min={1}
              max={5000}
              value={estado.limite_por_rodada}
              onChange={(e) => atualizar("limite_por_rodada", Number(e.target.value) || 1)}
            />
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-medium">{t("Base legal (LGPD)")}</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t("Base legal")}</Label>
            <Select
              value={estado.base_legal}
              onValueChange={(v) => atualizar("base_legal", v as RecuperacaoConfig["base_legal"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="consent">{t("Consentimento")}</SelectItem>
                <SelectItem value="legitimate_interest">{t("Interesse legítimo")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {estado.base_legal === "legitimate_interest" && (
            <div className="flex flex-col gap-1.5">
              <Label>{t("Referência da avaliação (LIA)")}</Label>
              <Input
                value={estado.lia_ref ?? ""}
                onChange={(e) => atualizar("lia_ref", e.target.value)}
              />
            </div>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onSalvar} disabled={!podeSalvar || salvar.isPending}>
          {t("Salvar")}
        </Button>
        <Button variant="outline" onClick={onDisparar} disabled={disparar.isPending || !estado.ativo}>
          {t("Disparar agora")}
        </Button>
      </div>
    </div>
  );
}
