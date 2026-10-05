/**
 * GET /api/v1/metrics/leads-por-horario — heatmap de dia-da-semana × hora em
 * que o lead entra em contato (migration 0560).
 *
 * Escopo = a PRÓPRIA RLS, igual às rotas irmãs: `fn_leads_por_horario` é
 * SECURITY INVOKER e roda com o client de sessão, então `messages`/
 * `conversations` já filtram por `fn_user_org_ids()`. Org vem do cookie
 * validado, NUNCA do body/query. Read-only ⇒ sem audit.
 *
 * Piso `agent`, mesmo de `/metrics/attendants` e `/metrics/atrito`: sem
 * filtro por atendente — é propriedade do sistema (quando o telefone toca),
 * não performance individual.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { type LeadsPorHorarioRaw } from "@/lib/metrics/leads-por-horario";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const VAZIO: LeadsPorHorarioRaw = { timezone: "America/Sao_Paulo", grade: [], por_hora: [] };

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_leads_por_horario", {
    p_org: activeOrg.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const raw = (data ?? VAZIO) as unknown as LeadsPorHorarioRaw;

  return ok(
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      timezone: raw.timezone,
      grade: raw.grade,
      por_hora: raw.por_hora,
    },
    { requestId },
  );
}
