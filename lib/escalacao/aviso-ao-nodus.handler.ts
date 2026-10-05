/**
 * Avisa o Nodus quando a IA abre um caso ou passa a conversa pra uma pessoa.
 * O Nodus (dono da loja) cria o sino e manda WhatsApp pro número de avisos —
 * sem depender da tela "aviso de caso" estar configurada aqui.
 *
 * Sem `NODUS_BASE_URL` → `skipped` (instalação sem Nodus). Falha de rede →
 * `error` (o dreno re-tenta). Nunca grava o texto do cliente: só título/resumo
 * do caso, que o próprio agente escreveu.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkDoCaso } from "@/lib/escalacao/url-publica";

export const AVISO_AO_NODUS_HANDLER_KEY = "escalacao-aviso-ao-nodus.v1";

const EVENTO_CASO = "ai.case_opened";
const EVENTO_HANDOFF = "ai.handoff_opened";

export const avisoAoNodusHandler: EventHandler = {
  key: AVISO_AO_NODUS_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_CASO, EVENTO_HANDOFF],
  async handle(row): Promise<HandlerResult> {
    const key = AVISO_AO_NODUS_HANDLER_KEY;
    const baseUrl = process.env.NODUS_BASE_URL;
    if (!baseUrl) return { consumer_key: key, status: "skipped", detail: "sem_nodus" };

    try {
      let titulo = "O atendente de IA passou uma conversa pra você";
      let resumo = "Abra o CRM (Mensagens) e assuma o atendimento.";
      let tipo: "caso" | "handoff" = "handoff";
      let link = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/app/inbox`;

      if (row.event_type === EVENTO_CASO) {
        tipo = "caso";
        const caseId = String(row.payload?.case_id ?? row.entity_id ?? "");
        if (!caseId) return { consumer_key: key, status: "skipped", detail: "payload_incompleto" };
        link = linkDoCaso(env.NEXT_PUBLIC_APP_URL, caseId);
        const { data: caso } = await createAdminClient()
          .from("agent_cases")
          .select("title, summary, source, status")
          .eq("id", caseId)
          .eq("organization_id", row.organization_id)
          .maybeSingle();
        if (!caso) return { consumer_key: key, status: "skipped", detail: "caso_inexistente" };
        if (!["agent", "guardrail_autofallback"].includes(String(caso.source))) {
          return { consumer_key: key, status: "skipped", detail: `origem:${caso.source}` };
        }
        if (!["awaiting_human", "awaiting_lead"].includes(String(caso.status))) {
          return { consumer_key: key, status: "skipped", detail: `caso_fechado:${caso.status}` };
        }
        titulo = `Caso novo: ${String(caso.title ?? "").slice(0, 120)}`;
        resumo = String(caso.summary ?? "").slice(0, 600);
      }

      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/crm/aviso-escalacao`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": env.INTERNAL_SECRET },
        body: JSON.stringify({
          organization_id: row.organization_id,
          event_id: row.id,
          tipo,
          titulo,
          resumo,
          link,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // 404 = loja sem vínculo no Nodus: não adianta re-tentar.
      if (res.status === 404) return { consumer_key: key, status: "skipped", detail: "org_sem_loja_no_nodus" };
      if (!res.ok) return { consumer_key: key, status: "error", detail: `nodus_http_${res.status}` };
      return { consumer_key: key, status: "ok", detail: tipo };
    } catch (err) {
      return { consumer_key: key, status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
