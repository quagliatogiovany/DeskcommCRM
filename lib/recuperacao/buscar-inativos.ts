/**
 * A busca no Nodus — quem, dentre os contatos que o CRM JÁ tem, está inativo
 * nesta loja.
 *
 * ═══ Por que o CRM manda telefone, e o Nodus só responde ═══
 *
 * O Nodus nunca exporta cliente novo pro CRM: a lista de telefones sai DAQUI,
 * o Nodus só filtra quem, dentro dela, passou do prazo sem pedir. Um telefone
 * que o Nodus devolva mas que não estava na lista de entrada é descartado —
 * defesa extra contra um bug do outro lado virar vazamento deste.
 *
 * ═══ Por que a chave de casamento não é o `phone_number` cru ═══
 *
 * O CRM guarda E.164 (`+5511987654321`); o Nodus devolve a forma canônica dele
 * (`11987654321`, sem DDI) — mesmo cálculo de `canonicalPhone` em
 * `src/lib/customers.ts` do Nodus. `chaveDeCasamento` replica esse cálculo
 * pra casar os dois sem normalizar o dado guardado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nodusRequest } from "@/lib/mcp/tools/nodus-client";

const LOTE_DE_TELEFONES = 500;

export interface ClienteInativo {
  contactId: string;
  telefone: string;
  nome: string | null;
  diasSemPedir: number;
  ultimoPedido: { itens: string; total: number; data: string } | null;
}

interface RespostaNodus {
  clientes: Array<{
    telefone: string;
    nome: string | null;
    diasSemPedir: number;
    ultimoPedido: { itens: string; total: number; data: string } | null;
  }>;
}

/** Mesmo cálculo de `canonicalPhone` no Nodus — DDD + número, sem `+55`. */
function chaveDeCasamento(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");
  return digitos.length > 11 && digitos.startsWith("55") ? digitos.slice(2) : digitos;
}

/**
 * Todos os contatos elegíveis (com telefone, não bloqueado/anonimizado/mesclado)
 * desta organização, e dentre eles quem o Nodus diz estar inativo.
 */
export async function buscarClientesInativos(
  admin: SupabaseClient,
  organizationId: string,
  diasSemPedido: number,
): Promise<ClienteInativo[]> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, phone_number")
    .eq("organization_id", organizationId)
    .is("is_merged_into", null)
    .eq("is_blocked", false)
    .eq("is_anonymized", false)
    .not("phone_number", "is", null);
  if (error) throw new Error(`recuperação: contatos — ${error.message}`);

  const contatos = (data ?? []) as { id: string; phone_number: string }[];
  if (contatos.length === 0) return [];

  const contactIdPorChave = new Map<string, string>();
  for (const c of contatos) contactIdPorChave.set(chaveDeCasamento(c.phone_number), c.id);

  const telefones = contatos.map((c) => c.phone_number);
  const resultado: ClienteInativo[] = [];
  const ctx = { supabase: admin, organizationId };

  for (let i = 0; i < telefones.length; i += LOTE_DE_TELEFONES) {
    const lote = telefones.slice(i, i + LOTE_DE_TELEFONES);
    const resp = (await nodusRequest(ctx, {
      method: "POST",
      path: "api/integrations/deskcomm/clientes-inativos",
      body: { telefones: lote, diasSemPedido },
    })) as RespostaNodus;

    for (const cliente of resp.clientes ?? []) {
      const contactId = contactIdPorChave.get(chaveDeCasamento(cliente.telefone));
      if (!contactId) continue; // Nodus só devolveria telefone que recebeu — defesa extra.
      resultado.push({ contactId, ...cliente });
    }
  }

  return resultado;
}
