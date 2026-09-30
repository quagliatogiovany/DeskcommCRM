/**
 * ABRIR UMA RODADA — busca quem está inativo no Nodus, filtra cooldown, abre
 * uma campanha (origem='recuperacao') e a leva até `running`, pelas MESMAS
 * ações que a tela de Campanhas usa (`prepararAcao`/`iniciarAcao` em
 * `lib/campanhas/acoes.ts`). Chamado pelo cron (`app/api/v1/cron/
 * recuperacao-clientes`) e pela rota "Disparar agora"
 * (`app/api/v1/recuperacao/disparar`).
 *
 * ═══ Por que não reinventa preparação/envio ═══
 *
 * Opt-out, supressão, duplicado, janela de horário, ritmo por número — tudo
 * isso já existe e é testado em `lib/campanhas/*`. A única coisa que a
 * recuperação acrescenta é DE ONDE vem a lista (Nodus, não o filtro genérico) e
 * duas variáveis extra por destinatário (`diasSemPedir`, `ultimoPedido`), que
 * entram pelo parâmetro opcional `extraPorContato` das mesmas funções.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { prepararAcao, iniciarAcao, carregarCampanha } from "@/lib/campanhas/acoes";
import { FILTRO_VAZIO } from "@/lib/campanhas/audiencia";
import { criarCampanha } from "@/lib/campanhas/criar";

import { buscarClientesInativos, type ClienteInativo } from "./buscar-inativos";
import { carregarConfig } from "./config";

export type ResultadoRodada =
  | { ok: true; campanhaId: string; total: number; elegiveis: number }
  | { ok: false; motivo: string; campanhaId?: string };

function dataDaRodada(agora: Date): string {
  // Granularidade de dia em UTC. Imprecisão de fuso na borda do dia é aceitável
  // aqui: o que a coluna protege é "não abrir duas rodadas por engano", não o
  // calendário exato da organização.
  return agora.toISOString().slice(0, 10);
}

function descreverUltimoPedido(pedido: ClienteInativo["ultimoPedido"]): string | null {
  if (!pedido) return null;
  const valor = pedido.total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const data = new Date(pedido.data).toLocaleDateString("pt-BR");
  return `${pedido.itens} (${valor}, em ${data})`;
}

/**
 * Quem recebeu recuperação nos últimos `naoRepetirAntesDias` dias — não entra
 * de novo. Duas consultas simples, e não `campaign_recipients!inner`
 * `campaigns(origem)`: join embutido depende do nome da FK e nenhum teste
 * local o exercita (mesma régua de `lib/followup/engine.ts`).
 */
export async function filtrarPorCooldown(
  admin: SupabaseClient,
  organizationId: string,
  candidatos: ClienteInativo[],
  naoRepetirAntesDias: number,
  agora: Date,
): Promise<ClienteInativo[]> {
  if (candidatos.length === 0) return candidatos;

  const { data: campanhas, error: erroCampanhas } = await admin
    .from("campaigns")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("origem", "recuperacao");
  if (erroCampanhas) throw new Error(`recuperação: cooldown campanhas — ${erroCampanhas.message}`);
  const idsDeRecuperacao = (campanhas ?? []).map((c) => (c as { id: string }).id);
  if (idsDeRecuperacao.length === 0) return candidatos;

  const limite = new Date(agora.getTime() - naoRepetirAntesDias * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("campaign_recipients")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .in("campaign_id", idsDeRecuperacao)
    .gte("sent_at", limite)
    .in(
      "contact_id",
      candidatos.map((c) => c.contactId),
    );
  if (error) throw new Error(`recuperação: cooldown destinatários — ${error.message}`);
  const recentes = new Set((data ?? []).map((r) => (r as { contact_id: string }).contact_id));
  return candidatos.filter((c) => !recentes.has(c.contactId));
}

export async function abrirRodada(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date = new Date(),
): Promise<ResultadoRodada> {
  const config = await carregarConfig(admin, organizationId);
  if (!config || !config.ativo || !config.channelSessionId) {
    return { ok: false, motivo: "recuperacao_nao_configurada" };
  }

  const rodadaData = dataDaRodada(agora);

  const inativos = await buscarClientesInativos(admin, organizationId, config.diasSemPedido);
  if (inativos.length === 0) return { ok: false, motivo: "recuperacao_sem_inativos" };

  const elegiveis = await filtrarPorCooldown(
    admin,
    organizationId,
    inativos,
    config.naoRepetirAntesDias,
    agora,
  );
  if (elegiveis.length === 0) return { ok: false, motivo: "recuperacao_sem_inativos" };

  const selecionados = elegiveis.slice(0, config.limitePorRodada);
  const extraPorContato = new Map(
    selecionados.map((c) => [
      c.contactId,
      { diasSemPedir: c.diasSemPedir, ultimoPedido: descreverUltimoPedido(c.ultimoPedido) },
    ]),
  );

  const { data: criada, error: erroCriacao } = await criarCampanha(admin, organizationId, {
    name: `Recuperação ${rodadaData}`,
    channelSessionId: config.channelSessionId,
    messageBody: config.mensagem,
    baseLegal: config.baseLegal,
    liaRef: config.liaRef,
    audienceFilter: {
      ...FILTRO_VAZIO,
      incluir_contatos: selecionados.map((c) => c.contactId),
      limite: Math.max(selecionados.length, 1),
    },
    janelaInicioHora: config.janelaInicioHora,
    janelaFimHora: config.janelaFimHora,
    origem: "recuperacao",
    rodadaData,
    createdBy: null,
  });
  // 23505 = a unique index (organization_id, rodada_data) já barrou: outra
  // rodada de hoje já existe (cron duplicado, dois nós, ou já foi disparada à
  // mão hoje). Não é falha — é a trava fazendo o trabalho dela.
  if (erroCriacao) {
    if (erroCriacao.code === "23505") return { ok: false, motivo: "recuperacao_rodada_ja_aberta_hoje" };
    throw new Error(`recuperação: criar campanha — ${erroCriacao.message}`);
  }
  const campanhaId = (criada as { id: string }).id;

  const carregada1 = await carregarCampanha(admin, organizationId, campanhaId);
  if (!carregada1.ok) throw new Error("recuperação: campanha recém-criada não recarregou");

  const preparo = await prepararAcao(admin, carregada1.campanha, agora, extraPorContato);
  if (!preparo.ok) return { ok: false, motivo: preparo.codigo, campanhaId };

  const carregada2 = await carregarCampanha(admin, organizationId, campanhaId);
  if (!carregada2.ok) throw new Error("recuperação: campanha preparada não recarregou");

  const inicio = await iniciarAcao(admin, carregada2.campanha, agora);
  if (!inicio.ok) return { ok: false, motivo: inicio.codigo, campanhaId };

  return { ok: true, campanhaId, total: preparo.resumo.total, elegiveis: preparo.resumo.elegiveis };
}
