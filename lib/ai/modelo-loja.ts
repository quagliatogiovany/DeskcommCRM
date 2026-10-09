/**
 * Textos-modelo da atendente que o Nodus manda no provisionamento da loja.
 *
 * Só o FAQ precisa de uma escrita própria: vira um material da organização
 * (mesmo caminho de `POST /api/v1/ai/knowledge/sources`, tipo FAQ). Instruções e
 * regras da casa usam os caminhos que o wizard já tem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseFaqMarkdown } from "@/lib/ai/rag/ingest/faq";
import { canonizarTipoDeFonte } from "@/lib/ai/rag/tipos-de-fonte";

export const NOME_DO_FAQ_MODELO = "Perguntas frequentes";

/**
 * Cadastra o FAQ-modelo como material da organização e devolve o id.
 * Idempotente: se já existe material ativo com esse nome, devolve o dele e não
 * recria (repetir o passo do wizard é inofensivo). `null` = não deu para criar;
 * quem chama segue sem FAQ, o agente não depende dele para existir.
 */
export async function cadastrarFaqDoModelo(
  admin: SupabaseClient,
  orgId: string,
  faqMarkdown: string,
): Promise<string | null> {
  const { data: existente } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", NOME_DO_FAQ_MODELO)
    .eq("is_active", true)
    .maybeSingle();
  if (existente) return (existente as { id: string }).id;

  const itens = parseFaqMarkdown(faqMarkdown);
  if (itens.length === 0) return null;

  const { data: ks, error } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: orgId,
      agent_id: null,
      source_type: canonizarTipoDeFonte("faq") ?? "faq",
      name: NOME_DO_FAQ_MODELO,
      status: "ready",
      is_active: true,
      source_metadata: { origem: "modelo_loja" },
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !ks) return null;
  const id = (ks as { id: string }).id;

  const { error: itensErr } = await admin.from("ai_faq_items").insert(
    itens.map((item, idx) => ({
      organization_id: orgId,
      knowledge_source_id: id,
      question: item.question,
      answer: item.answer,
      tags: item.tags,
      locale: item.locale,
      position: idx,
    })),
  );
  if (itensErr) {
    // Fonte sem item é fonte vazia: desfaz, como a rota de materiais.
    await admin.from("ai_knowledge_sources").delete().eq("id", id);
    return null;
  }

  // Dispara a indexação (mesmo evento que a rota de materiais emite). Falha não bloqueia.
  await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: { knowledge_source_id: id, agent_id: null, source_type: "faq" },
    p_organization_id: orgId,
  } as never);

  return id;
}
