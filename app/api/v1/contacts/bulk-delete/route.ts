/**
 * POST /api/v1/contacts/bulk-delete — exclui vários contatos de uma vez.
 *
 * Cada contato passa pelo MESMO `deleteContactHandler` da exclusão individual:
 * mesma transação, mesma auditoria, mesma recusa quando há compromisso na
 * Agenda. Um que for barrado não impede os outros — a resposta diz quantos
 * saíram e quais ficaram, e por quê.
 *
 * Papel `manager` (a exclusão individual aceita `agent`): apagar dezenas de
 * fichas com o histórico de conversa é decisão de quem gerencia a base.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { deleteContactHandler } from "../_handler";

export const dynamic = "force-dynamic";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Selecione de 1 a 200 contatos."), 422, { requestId });
  }

  const supabase = await createClient();
  const ctx = {
    organization_id: authz.org.orgId,
    actor: { type: "user" as const, id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  const apagados: string[] = [];
  const barrados: Array<{ id: string; motivo: string }> = [];
  // Em série, e não em paralelo: cada exclusão é uma transação que mexe em
  // mensagens e conversas, e 200 delas simultâneas disputariam as mesmas linhas.
  for (const id of [...new Set(parsed.data.ids)]) {
    try {
      await deleteContactHandler(supabase, ctx, id);
      apagados.push(id);
    } catch (err) {
      if (err instanceof ApiError) {
        barrados.push({ id, motivo: err.status === 404 ? t("Contato não encontrado.") : err.message });
      } else {
        barrados.push({ id, motivo: t("Erro inesperado ao excluir.") });
      }
    }
  }

  return ok({ apagados: apagados.length, barrados }, { requestId });
}
