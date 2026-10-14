/**
 * As AÇÕES da campanha — preparar, iniciar, agendar, pausar, retomar, cancelar,
 * duplicar e testar.
 *
 * Moram aqui, e não em oito rotas, porque as oito fazem a mesma coisa em volta:
 * carregar a campanha da organização certa, perguntar à máquina de estados se a
 * transição vale, escrever, auditar. Espalhado, esse "em volta" diverge — e o
 * dia em que uma rota esquecer de conferir o estado é o dia em que uma campanha
 * cancelada volta a enviar.
 *
 * Cada função devolve `{ ok: false, codigo, mensagem, status }` em vez de lançar:
 * a rota traduz para `fail()` sem interpretar exceção, e o motivo chega ao
 * operador com o texto real (Regra nº 1).
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiErrorCode } from "@/lib/api/errors";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";

import { baseLegalValida, motivoParaExcluir, recusouMarketing } from "./elegibilidade";
import { ehStatusDaCampanha, podeTransitar } from "./maquina-de-estados";
import { prepararCampanha } from "./preparacao";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { camposDoDestinatario } from "./consulta-de-audiencia";
import { escolherVariante, renderizar } from "./renderizador";
import { TEXTO_DA_EXCLUSAO, type MotivoDeExclusao, type StatusDaCampanha } from "./tipos";

export interface CampanhaCarregada {
  id: string;
  organization_id: string;
  name: string;
  status: StatusDaCampanha;
  channel_session_id: string;
  message_body: string | null;
  base_legal: string;
  lia_ref: string | null;
  audience_filter: unknown;
  audience_version: number;
  content_version: number;
  scheduled_at: string | null;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
  description: string | null;
}

export type Recusa = { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };
export type Desfecho<T = unknown> = ({ ok: true } & T) | Recusa;

const COLUNAS =
  "id, organization_id, name, status, channel_session_id, message_body, base_legal, lia_ref, " +
  "audience_filter, audience_version, content_version, scheduled_at, description, " +
  "intervalo_segundos, janela_inicio_hora, janela_fim_hora, teto_diario, teto_horario";

export async function carregarCampanha(
  admin: SupabaseClient,
  organizationId: string,
  campanhaId: string,
): Promise<Desfecho<{ campanha: CampanhaCarregada }>> {
  const { data } = await admin
    .from("campaigns")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("id", campanhaId)
    .maybeSingle();
  if (!data) {
    return {
      ok: false,
      codigo: "campanha_nao_encontrada",
      mensagem: "Campanha não encontrada.",
      status: 404,
    };
  }
  const campanha = data as unknown as CampanhaCarregada;
  if (!ehStatusDaCampanha(campanha.status)) {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: `A campanha está num estado que este sistema não conhece ("${campanha.status}").`,
      status: 409,
    };
  }
  return { ok: true, campanha };
}

function recusaDeTransicao(de: StatusDaCampanha, para: StatusDaCampanha): Recusa | null {
  const r = podeTransitar(de, para);
  return r.pode ? null : { ok: false, codigo: "campanha_estado_invalido", mensagem: r.motivo, status: 409 };
}

/** O que toda campanha precisa ter antes de qualquer envio — inclusive o de teste. */
function faltaParaEnviar(c: CampanhaCarregada): Recusa | null {
  if ((c.message_body ?? "").trim() === "") {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: "Escreva a mensagem antes de preparar a campanha.",
      status: 422,
    };
  }
  if (!baseLegalValida({ baseLegal: c.base_legal, liaRef: c.lia_ref })) {
    return {
      ok: false,
      codigo: "campanha_base_legal_invalida",
      mensagem:
        "Interesse legítimo exige a referência da avaliação (LIA). Sem ela não há como responder " +
        "a quem perguntar com base em quê recebeu a mensagem.",
      status: 422,
    };
  }
  return null;
}

/** Já saiu alguma mensagem desta campanha? Reconstruir snapshot depois disso é proibido. */
async function jaEnviou(admin: SupabaseClient, campanhaId: string): Promise<boolean> {
  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .not("sent_at", "is", null);
  return (count ?? 0) > 0;
}

export async function prepararAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
  extraPorContato?: ReadonlyMap<string, { diasSemPedir?: number | null; ultimoPedido?: string | null }>,
): Promise<Desfecho<{ resumo: { total: number; elegiveis: number; excluidos: number } }>> {
  const recusa = recusaDeTransicao(c.status, "preparing") ?? faltaParaEnviar(c);
  if (recusa) return recusa;
  if (await jaEnviou(admin, c.id)) {
    return {
      ok: false,
      codigo: "campanha_nao_editavel",
      mensagem: "Esta campanha já enviou mensagens; refazer a lista mudaria o que já foi dito.",
      status: 409,
    };
  }

  // Compare-and-set: dois cliques simultâneos, e só um entra em `preparing`.
  const { data: entrou } = await admin
    .from("campaigns")
    .update({ status: "preparing" })
    .eq("id", c.id)
    .eq("status", "draft")
    .select("id");
  if ((entrou ?? []).length === 0) {
    return {
      ok: false,
      codigo: "campanha_preparando",
      mensagem: "A preparação desta campanha já está em andamento.",
      status: 409,
    };
  }

  try {
    const resumo = await prepararCampanha(admin, {
      campanhaId: c.id,
      organizationId: c.organization_id,
      filtro: c.audience_filter,
      corpo: c.message_body ?? "",
      contentVersion: c.content_version,
      agora,
      extraPorContato,
    });
    if (resumo.total === 0) {
      await voltarAoRascunho(admin, c.id, "audiencia_vazia");
      return {
        ok: false,
        codigo: "campanha_sem_audiencia",
        mensagem: "O recorte não encontrou nenhum contato. Ajuste o filtro.",
        status: 422,
      };
    }
    if (resumo.elegiveis === 0) {
      await voltarAoRascunho(admin, c.id, "sem_elegiveis");
      return {
        ok: false,
        codigo: "campanha_sem_elegiveis",
        mensagem: `O recorte encontrou ${resumo.total} contato(s), mas nenhum pode receber. ${descreverMotivos(resumo.motivos)}`,
        status: 422,
      };
    }

    await admin
      .from("campaigns")
      .update({
        status: "ready",
        prepared_at: agora.toISOString(),
        snapshot_total: resumo.total,
        snapshot_eligible: resumo.elegiveis,
        snapshot_excluded: resumo.excluidos,
        audience_version: c.audience_version + 1,
      })
      .eq("id", c.id)
      .eq("status", "preparing");

    return { ok: true, resumo };
  } catch (err) {
    // A campanha não pode ficar presa em `preparing`: quem tentou preparar
    // precisa poder corrigir o filtro e tentar de novo.
    await voltarAoRascunho(admin, c.id, "erro_na_preparacao");
    return {
      ok: false,
      codigo: "campanha_sem_audiencia",
      mensagem: err instanceof Error ? err.message : String(err),
      status: 422,
    };
  }
}

function descreverMotivos(motivos: Partial<Record<MotivoDeExclusao, number>>): string {
  const partes = Object.entries(motivos)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([m, n]) => `${n} — ${TEXTO_DA_EXCLUSAO[m as MotivoDeExclusao]}`);
  return partes.length ? `Motivos: ${partes.join("; ")}.` : "";
}

async function voltarAoRascunho(admin: SupabaseClient, id: string, codigo: string): Promise<void> {
  await admin
    .from("campaigns")
    .update({ status: "draft", failure_code: codigo })
    .eq("id", id)
    .eq("status", "preparing");
}

export async function iniciarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
): Promise<Desfecho<{ retomada: boolean }>> {
  const recusa = recusaDeTransicao(c.status, "running") ?? faltaParaEnviar(c);
  if (recusa) return recusa;

  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", c.id)
    .eq("eligibility_status", "eligible");
  if ((count ?? 0) === 0) {
    return {
      ok: false,
      codigo: "campanha_sem_elegiveis",
      mensagem: "Nenhum destinatário elegível. Prepare a campanha antes de iniciar.",
      status: 422,
    };
  }

  const retomada = c.status === "paused";
  const { data } = await admin
    .from("campaigns")
    .update({
      status: "running",
      started_at: agora.toISOString(),
      paused_at: null,
      scheduled_at: null,
    })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  return { ok: true, retomada };
}

export async function agendarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  quando: Date,
  agora: Date,
): Promise<Desfecho> {
  const recusa = recusaDeTransicao(c.status, "scheduled") ?? faltaParaEnviar(c);
  if (recusa) return recusa;
  if (quando.getTime() <= agora.getTime()) {
    return {
      ok: false,
      codigo: "campanha_agenda_invalida",
      mensagem: "Escolha uma data no futuro — para enviar agora, use Iniciar.",
      status: 422,
    };
  }
  const { data } = await admin
    .from("campaigns")
    .update({ status: "scheduled", scheduled_at: quando.toISOString(), paused_at: null })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  return { ok: true };
}

export async function pausarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
): Promise<Desfecho> {
  const recusa = recusaDeTransicao(c.status, "paused");
  if (recusa) return recusa;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "paused", paused_at: agora.toISOString() })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  // Quem já estava `sending` NÃO é desfeito: a mensagem pode estar na borda
  // externa neste instante, e prometer cancelamento do que já saiu é mentir.
  return { ok: true };
}

export async function cancelarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
): Promise<Desfecho<{ cancelados: number }>> {
  const recusa = recusaDeTransicao(c.status, "cancelled");
  if (recusa) return recusa;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "cancelled", cancelled_at: agora.toISOString() })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();

  // A campanha já está cancelada quando esta linha roda: a rodada não escolhe
  // mais esta campanha, então não há corrida com o worker por estes pendentes.
  const { data: cancelados } = await admin
    .from("campaign_recipients")
    .update({ status: "cancelled", cancelled_at: agora.toISOString() })
    .eq("campaign_id", c.id)
    .in("status", ["pending", "queued"])
    .select("id");
  return { ok: true, cancelados: (cancelados ?? []).length };
}

/** "Promo (cópia 2)" → "Promo": a cópia da cópia numera a partir do nome original. */
function nomeBase(nome: string): string {
  return nome.replace(/\s*\(cópia(?: \d+)?\)\s*$/i, "").trim();
}

async function proximoNomeDeCopia(
  admin: SupabaseClient,
  organizationId: string,
  nome: string,
): Promise<string> {
  const base = nomeBase(nome);
  const { data } = await admin
    .from("campaigns")
    .select("name")
    .eq("organization_id", organizationId)
    .ilike("name", `${base.replace(/[\\%_]/g, "\\$&")} (cópia%`);
  let maior = 0;
  for (const { name } of (data ?? []) as Array<{ name: string }>) {
    const m = /\(cópia(?: (\d+))?\)\s*$/i.exec(name);
    if (m) maior = Math.max(maior, m[1] ? Number(m[1]) : 1);
  }
  // O sufixo cabe sempre: é o nome que encolhe, não a numeração.
  const sufixo = ` (cópia ${maior + 1})`;
  return `${base.slice(0, 160 - sufixo.length)}${sufixo}`;
}

export async function duplicarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  autorId: string,
): Promise<Desfecho<{ id: string }>> {
  const { data: origem } = await admin
    .from("campaigns")
    .select("pipeline_id, stage_id, agent_id")
    .eq("id", c.id)
    .maybeSingle();
  const destino = (origem ?? {}) as { pipeline_id?: string | null; stage_id?: string | null; agent_id?: string | null };
  const { data, error } = await admin
    .from("campaigns")
    .insert({
      organization_id: c.organization_id,
      name: await proximoNomeDeCopia(admin, c.organization_id, c.name),
      pipeline_id: destino.pipeline_id ?? null,
      stage_id: destino.stage_id ?? null,
      agent_id: destino.agent_id ?? null,
      description: c.description,
      channel_session_id: c.channel_session_id,
      message_body: c.message_body,
      base_legal: c.base_legal,
      lia_ref: c.lia_ref,
      audience_filter: c.audience_filter,
      intervalo_segundos: c.intervalo_segundos,
      janela_inicio_hora: c.janela_inicio_hora,
      janela_fim_hora: c.janela_fim_hora,
      teto_diario: c.teto_diario,
      teto_horario: c.teto_horario,
      created_by: autorId,
      // Nada de destinatário, resultado, agenda ou carimbo de execução: a cópia
      // é uma INTENÇÃO nova, e herdar números faria a tela mostrar entrega de
      // mensagem que esta campanha nunca mandou.
    })
    .select("id")
    .single();
  if (error || !data) {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: error?.message ?? "Não foi possível duplicar a campanha.",
      status: 422,
    };
  }
  return { ok: true, id: (data as { id: string }).id };
}

const POR_PAGINA = 200;

/**
 * Troca o texto de QUEM AINDA NÃO RECEBEU. Quem já saiu mantém o que recebeu.
 *
 * Só com a campanha parada (pausada, preparada ou agendada): com ela em `running`
 * o worker reserva o próximo pendente a cada rodada, e a troca correria contra
 * ele — alguém receberia o texto velho no meio da mudança. Pausar é o preço da
 * garantia de que ninguém fura a fila.
 *
 * Cada pendente é re-renderizado com o texto novo (nome, dias sem pedir, campos
 * personalizados). Quem não tem um dado que o texto novo exige sai da lista com
 * o mesmo motivo da preparação (`variavel_ausente`), em vez de receber "Olá ,".
 */
export async function editarMensagemAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  corpo: string,
): Promise<Desfecho<{ atualizados: number; removidos: number }>> {
  if (c.status !== "paused" && c.status !== "ready" && c.status !== "scheduled") {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: "Pause a campanha antes de trocar a mensagem — assim ninguém recebe o texto antigo durante a troca.",
      status: 409,
    };
  }
  const texto = corpo.trim();
  if (texto === "") {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: "Escreva a mensagem.", status: 422 };
  }

  const versao = c.content_version + 1;
  const { data: gravou } = await admin
    .from("campaigns")
    .update({ message_body: texto, content_version: versao })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((gravou ?? []).length === 0) return conflitoDeCorrida();

  let atualizados = 0;
  let removidos = 0;
  for (;;) {
    // `content_version < versao` é o que faz o laço andar: quem foi tratado sai do filtro.
    const { data: lote } = await admin
      .from("campaign_recipients")
      .select("id, contact_id, variables, contacts(id, name, display_name, phone_number)")
      .eq("organization_id", c.organization_id)
      .eq("campaign_id", c.id)
      .eq("status", "pending")
      .lt("content_version", versao)
      .order("id", { ascending: true })
      .limit(POR_PAGINA);
    const linhas = (lote ?? []) as unknown as Array<{
      id: string;
      contact_id: string;
      variables: { diasSemPedir?: number | null; ultimoPedido?: string | null } | null;
      contacts: { id: string; name: string | null; display_name: string | null; phone_number: string | null } | null;
    }>;
    if (linhas.length === 0) break;

    for (const l of linhas) {
      const campos = await camposDoDestinatario(admin, {
        organizationId: c.organization_id,
        contactId: l.contact_id,
        corpo: texto,
      });
      const r = renderizar(texto, {
        nome: l.contacts ? nomeDoContato(l.contacts) : null,
        diasSemPedir: l.variables?.diasSemPedir ?? null,
        ultimoPedido: l.variables?.ultimoPedido ?? null,
        ...campos,
      });
      const mudanca =
        r.faltando.length > 0
          ? {
              status: "skipped",
              eligibility_status: "excluded",
              exclusion_reason: "variavel_ausente",
              recipient_address: null,
              content_version: versao,
            }
          : { rendered_body: r.texto, content_version: versao };
      // `status = pending` de novo: se o worker pegou este destinatário entre a
      // leitura e a escrita, ele sai com o texto antigo e não o sobrescrevemos.
      const { data: tocou } = await admin
        .from("campaign_recipients")
        .update(mudanca)
        .eq("id", l.id)
        .eq("status", "pending")
        .select("id");
      if ((tocou ?? []).length > 0) {
        if (r.faltando.length > 0) removidos += 1;
        else atualizados += 1;
      }
    }
  }

  if (removidos > 0) await recontarSnapshot(admin, c);
  return { ok: true, atualizados, removidos };
}

/**
 * Tira da lista quem ainda NÃO recebeu (selecionados, ou todos os pendentes).
 *
 * Não apaga contato nenhum do CRM: o destinatário vira "Fora da lista"
 * (`excluido_manualmente`) só NESTA campanha. Quem já foi enviado não é tocado —
 * a mensagem já saiu e o histórico dela fica.
 */
export async function removerDestinatariosAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  entrada: { ids?: string[]; todos?: boolean },
): Promise<Desfecho<{ removidos: number }>> {
  if (c.status !== "ready" && c.status !== "scheduled" && c.status !== "paused" && c.status !== "running") {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: "Só dá para tirar gente da lista de uma campanha preparada que ainda não terminou.",
      status: 409,
    };
  }
  let q = admin
    .from("campaign_recipients")
    .update({
      status: "skipped",
      eligibility_status: "excluded",
      exclusion_reason: "excluido_manualmente",
      recipient_address: null,
    })
    .eq("organization_id", c.organization_id)
    .eq("campaign_id", c.id)
    // `pending` e nada mais: quem está `queued`/`sending` pode ter a mensagem na
    // borda neste instante, e prometer que não sai seria mentir.
    .eq("status", "pending");
  if (!entrada.todos) {
    const ids = entrada.ids ?? [];
    if (ids.length === 0) {
      return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: "Selecione quem sai da lista.", status: 422 };
    }
    q = q.in("id", ids);
  }
  const { data, error } = await q.select("id");
  if (error) {
    return { ok: false, codigo: "campanha_estado_invalido", mensagem: error.message, status: 422 };
  }
  const removidos = (data ?? []).length;
  if (removidos > 0) await recontarSnapshot(admin, c);
  return { ok: true, removidos };
}

/** Os totais da tela refletem a lista de agora, não a da preparação. */
async function recontarSnapshot(admin: SupabaseClient, c: CampanhaCarregada): Promise<void> {
  const contar = async (eligibility: "eligible" | "excluded") => {
    const { count } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", c.organization_id)
      .eq("campaign_id", c.id)
      .eq("eligibility_status", eligibility);
    return count ?? 0;
  };
  const [elegiveis, excluidos] = await Promise.all([contar("eligible"), contar("excluded")]);
  await admin
    .from("campaigns")
    .update({ snapshot_eligible: elegiveis, snapshot_excluded: excluidos, snapshot_total: elegiveis + excluidos })
    .eq("id", c.id);
}

/**
 * O teste: a MESMA conexão, o MESMO renderizador, a MESMA camada de envio.
 *
 * Um teste que passasse por outro caminho provaria o outro caminho. E ele não
 * toca nos contadores da execução oficial — não cria destinatário, não gasta
 * fila —, mas gasta o ritmo do número, porque para o WhatsApp é uma mensagem
 * como qualquer outra.
 */
export async function testarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  contactId: string,
  agora: Date,
  fuso: string,
): Promise<Desfecho<{ status: string }>> {
  const recusa = faltaParaEnviar(c);
  if (recusa) return recusa;

  const { data: contato } = await admin
    .from("contacts")
    .select("id, name, display_name, phone_number, is_blocked, is_anonymized, consent")
    .eq("organization_id", c.organization_id)
    .eq("id", contactId)
    .maybeSingle();
  if (!contato) {
    return {
      ok: false,
      codigo: "campanha_nao_encontrada",
      mensagem: "Contato de teste não encontrado nesta organização.",
      status: 404,
    };
  }
  const linha = contato as {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
    consent: unknown;
  };

  // O teste respeita os MESMOS vetos: mandar teste para quem pediu para parar
  // seria furar o opt-out pela porta dos fundos.
  const motivo = motivoParaExcluir({
    contactId: linha.id,
    telefone: linha.phone_number,
    bloqueado: linha.is_blocked,
    anonimizado: linha.is_anonymized,
    recusouMarketing: recusouMarketing(linha.consent),
  });
  if (motivo) {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: `Este contato não pode receber: ${motivo}.`,
      status: 422,
    };
  }

  // Os campos personalizados que o TEXTO usa entram aqui pelo MESMO caminho da
  // prévia: teste que não resolvia `{{lead.gancho}}` reprovaria o texto que o
  // envio manda certo.
  const campos = await camposDoDestinatario(admin, {
    organizationId: c.organization_id,
    contactId: linha.id,
    corpo: c.message_body ?? "",
  });
  const render = renderizar(
    escolherVariante(c.message_body ?? ""),
    { nome: nomeDoContato(linha), ...campos },
    { agora, fuso },
  );
  if (render.faltando.length > 0) {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: `Falta ${render.faltando.join(", ")} no cadastro deste contato — escolha outro para o teste.`,
      status: 422,
    };
  }

  const boundary = await beginServiceAtOrigin(admin, c.organization_id, linha.id, c.channel_session_id);
  const mensagem = await sendMessageHandler(
    admin,
    {
      organization_id: c.organization_id,
      serviceBoundary: boundary,
      proactiveContext: { organizationId: c.organization_id, contactId: linha.id },
      actor: { type: "webhook_source", id: `campaign-test:${c.id}` },
      requestId: `campaign-test:${c.id}:${randomUUID()}`,
    } as Parameters<typeof sendMessageHandler>[1],
    {
      conversation_id: boundary.conversation_id,
      type: "text",
      body: render.texto,
      metadata: { source: "campaign_test", campaign_id: c.id },
    } as Parameters<typeof sendMessageHandler>[2],
  );

  const status = (mensagem as { status?: string }).status ?? "desconhecido";
  if (status === "failed") {
    return {
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: "O envio de teste falhou no canal. Verifique a conexão antes de iniciar a campanha.",
      status: 409,
    };
  }
  return { ok: true, status };
}

function conflitoDeCorrida(): Recusa {
  return {
    ok: false,
    codigo: "campanha_estado_invalido",
    mensagem: "O estado da campanha mudou enquanto esta ação era processada. Recarregue a tela.",
    status: 409,
  };
}
