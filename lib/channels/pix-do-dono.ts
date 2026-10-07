/**
 * O dono responde "OK 7F3K" (ou "OK Maria", ou só "OK") ao aviso de Pix aguardando — e o pedido parado é liberado.
 *
 * É DETERMINÍSTICO, sem IA: a mensagem não passa pelo agente. Quem decide se a pessoa pode liberar é o Nodus
 * (`POST .../pedidos/confirmar-pix`): ele só aceita o número cadastrado como WhatsApp de avisos da loja. Aqui só se
 * reconhece a forma "ok ..." e se repassa o remetente e o texto. Para qualquer cliente que escreva "ok" numa conversa
 * normal, o Nodus responde 403 e esta função devolve `false` — a mensagem segue o caminho de sempre, sem efeito.
 *
 * Chamado de `aplicarEfeitosPosEntrada`, antes dos demais efeitos: o "ok" do dono não deve abrir demanda nem acordar o
 * agente. Devolve `true` quando tratou a mensagem (e respondeu ao dono).
 */
import { randomUUID } from "node:crypto";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { logger } from "@/lib/logger";
import { NodusApiError, nodusRequest } from "@/lib/mcp/tools/nodus-client";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EntradaDeMensagem } from "./pos-entrada";

type Admin = SupabaseClient;

const PIX_ACTOR_ID = "pix-do-dono";

/** "ok", "OK 7F3K", "ok: maria", "Ok, 7f3k!" — só no começo da mensagem e curto: conversa de verdade não casa. */
const OK_DO_DONO = /^\s*ok\b[\s:,.!-]*([^\n]{0,60}?)[\s.!]*$/i;

/** O que veio depois do "ok" (código ou nome, possivelmente vazio), ou `null` se a mensagem não é um "ok". */
export function extrairOkDoDono(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = OK_DO_DONO.exec(texto);
  return m ? (m[1] ?? "").trim() : null;
}

interface PixConfirmado {
  codigo: string;
  cliente: string;
  total: number;
  despachado: boolean;
}

const reais = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function respostaAoDono(p: PixConfirmado): string {
  return p.despachado
    ? `Pix confirmado ✅ Pedido ${p.codigo} de ${p.cliente} (${reais(p.total)}) liberado para o motoboy.`
    : `Pix confirmado ✅ Pedido ${p.codigo} de ${p.cliente} (${reais(p.total)}), mas não há motoboy livre agora. Você recebe o alerta de pedido sem motoboy.`;
}

export async function confirmarPixDoDono(admin: Admin, entrada: EntradaDeMensagem): Promise<boolean> {
  const depoisDoOk = extrairOkDoDono(entrada.texto);
  if (depoisDoOk === null) return false;

  try {
    const { data: contato } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    const telefone = (contato?.phone_number as string | null) ?? null;
    if (!telefone) return false;

    let resposta: string;
    try {
      const body = (await nodusRequest(
        { supabase: admin, organizationId: entrada.organizationId },
        {
          method: "POST",
          path: "api/integrations/deskcomm/pedidos/confirmar-pix",
          body: { telefoneDoDono: telefone, texto: depoisDoOk },
        },
      )) as PixConfirmado;
      resposta = respostaAoDono(body);
    } catch (err) {
      if (!(err instanceof NodusApiError)) throw err;
      // Quem fala com o dono: ele É o dono (o Nodus não recusou o número), então o texto do Nodus serve — "há mais de
      // um Pix aguardando: ...", "não há Pix aguardando". Qualquer outra recusa (não é o dono, loja sem Nodus ativo,
      // erro do Nodus) NÃO é conversa do dono: segue o caminho normal, como se o "ok" fosse de um cliente.
      if (err.code !== "AMBIGUO" && err.code !== "PEDIDO_NAO_ENCONTRADO") return false;
      resposta = err.message;
    }

    await sendMessageHandler(
      admin,
      {
        organization_id: entrada.organizationId,
        actor: { type: "ai_agent", id: PIX_ACTOR_ID, role: "manager" },
        requestId: entrada.requestId ?? randomUUID(),
      },
      { conversation_id: entrada.conversationId, type: "text", body: resposta },
    );
    logger.info("pix-do-dono: Pix liberado pelo dono, agente não despachado", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
    });
    return true;
  } catch (err) {
    // Best-effort, como a triagem Jev: falha aqui não derruba a cadeia de efeitos; o "ok" segue o caminho normal e o
    // dono ainda tem o botão no painel.
    logger.warn("pix-do-dono: falhou, segue o caminho normal", {
      organization_id: entrada.organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
