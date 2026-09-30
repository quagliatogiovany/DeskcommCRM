/**
 * Ficha do cliente pro card do contato no inbox — GET sob demanda (ver
 * POST /api/integrations/deskcomm/clientes/ficha no repo do Nodus).
 *
 * Mesmo espírito de lib/recuperacao/buscar-inativos.ts: um `fetch` fino,
 * autenticado com a `nodus_api_key` da organização. A diferença é o volume —
 * ali é lote (campanha), aqui é 1 telefone por vez (abrir uma conversa).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nodusRequest } from "@/lib/mcp/tools/nodus-client";

export interface FichaClienteNodus {
  nome: string | null;
  shortCode: number | null;
  status: string;
  endereco: string | null;
  referralCode: string | null;
  creditoDisponivel: number;
  tags: string[];
  notas: string | null;
  clienteDesde: string;
  totalPedidos: number;
  diasSemPedir: number | null;
  ultimoPedido: { itens: string; total: number; status: string; data: string } | null;
}

interface RespostaNodus {
  ficha: FichaClienteNodus | null;
}

export interface ResultadoFicha {
  ficha: FichaClienteNodus | null;
  erro: boolean;
}

/**
 * `erro: false` com `ficha: null` cobre DOIS estados sem falha nenhuma: o
 * telefone não é cliente cadastrado nesta loja, ou a organização não tem
 * `nodus_api_key` configurada (não usa Nodus). Só falha de rede/HTTP vira
 * `erro: true` — a mesma distinção que `enrichment_error` já faz ao lado.
 */
export async function buscarFichaCliente(
  admin: SupabaseClient,
  organizationId: string,
  telefone: string,
): Promise<ResultadoFicha> {
  try {
    const resp = (await nodusRequest(
      { supabase: admin, organizationId },
      { method: "POST", path: "api/integrations/deskcomm/clientes/ficha", body: { telefone } },
    )) as RespostaNodus;
    return { ficha: resp.ficha ?? null, erro: false };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("nodus_nao_configurado")) {
      return { ficha: null, erro: false };
    }
    return { ficha: null, erro: true };
  }
}
