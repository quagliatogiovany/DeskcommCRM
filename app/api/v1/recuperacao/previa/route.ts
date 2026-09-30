/**
 * GET /api/v1/recuperacao/previa — quantos clientes seriam recuperados AGORA,
 * sem gravar nada. Aceita `dias_sem_pedido`/`nao_repetir_antes_dias` na query
 * pra a tela mostrar a contagem mudando enquanto o operador ajusta o campo,
 * antes de salvar a configuração.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { buscarClientesInativos } from "@/lib/recuperacao/buscar-inativos";
import { filtrarPorCooldown } from "@/lib/recuperacao/abrir-rodada";
import { carregarConfig } from "@/lib/recuperacao/config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  dias_sem_pedido: z.coerce.number().int().min(1).max(3650).optional(),
  nao_repetir_antes_dias: z.coerce.number().int().min(1).max(3650).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "recuperacao_previa" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const config = await carregarConfig(admin, authz.org.orgId);
  const diasSemPedido = parsed.data.dias_sem_pedido ?? config?.diasSemPedido ?? 30;
  const naoRepetirAntesDias = parsed.data.nao_repetir_antes_dias ?? config?.naoRepetirAntesDias ?? 30;

  let inativos;
  try {
    inativos = await buscarClientesInativos(admin, authz.org.orgId, diasSemPedido);
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    if (mensagem.includes("nodus_nao_configurado") || mensagem.includes("nodus_org_lookup_falhou")) {
      return fail(
        "recuperacao_nao_configurada_no_nodus",
        t("Esta loja ainda não está ligada ao Nodus."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", mensagem, 502, { requestId });
  }

  const elegiveis = await filtrarPorCooldown(admin, authz.org.orgId, inativos, naoRepetirAntesDias, new Date());

  return ok(
    {
      total_inativos: inativos.length,
      elegiveis: elegiveis.length,
      excluidos_por_cooldown: inativos.length - elegiveis.length,
      amostra: elegiveis
        .slice(0, 20)
        .map((c) => ({ nome: c.nome, dias_sem_pedir: c.diasSemPedir })),
    },
    { requestId },
  );
}
