/**
 * POST /api/internal/nodus/avisar-dono — o Nodus manda um aviso operacional
 * (Pix a conferir, cancelamento pedido, cliente travado no código) pro WhatsApp
 * do DONO da loja, pelo número que a organização já tem conectado aqui.
 *
 * Por que existe: o envio de aviso do Nodus falava só com a Evolution API, que
 * morreu. O canal de WhatsApp agora é o do CRM.
 *
 * Deliberadamente NÃO abre conversa nem contato: o dono não é um cliente, então
 * nada disto entra na caixa de entrada. Vai direto pelo adapter do canal da
 * organização (WORKING primeiro). Sem canal pronto → 409, e o Nodus só segue com
 * o aviso do sino, que é o que ele já fazia.
 *
 * Auth: `x-internal-secret` (mesmo padrão de /api/internal/provisioning/org).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { CHANNEL_SESSION_REF_COLUMNS, DEFAULT_CHANNEL_PROVIDER, getAdapter, resolveSessionRef } from "@/lib/channels";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  organization_id: z.string().uuid(),
  phone_number: z.string().trim().min(8).max(32),
  body: z.string().trim().min(1).max(2000),
});

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function authorize(req: NextRequest): boolean {
  const expected = env.INTERNAL_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers.get("x-internal-secret");
  if (headerSecret && timingSafeEq(headerSecret, expected)) return true;
  const authz = req.headers.get("authorization");
  const match = authz ? /^Bearer\s+(.+)$/i.exec(authz.trim()) : null;
  return !!match && timingSafeEq(match[1]!.trim(), expected);
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorize(req)) return fail("unauthenticated", "Internal secret missing or invalid.", 401);

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { details: parsed.error.flatten() });
  }
  const { organization_id: organizationId, phone_number: phone, body } = parsed.data;

  const admin = createAdminClient();
  const sessionId = await sessaoProntaParaEnvio(admin, organizationId);
  if (!sessionId) return fail("no_channel", "A organização não tem canal de WhatsApp conectado.", 409);

  const { data: session } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .single();
  if (!session) return fail("no_channel", "Canal não encontrado.", 409);

  const provider = (session as { provider?: string }).provider ?? DEFAULT_CHANNEL_PROVIDER;
  const adapter = getAdapter(provider as Parameters<typeof getAdapter>[0]);
  const to = adapter.resolveRecipient({
    isGroup: false,
    groupChatId: null,
    phoneNumber: phone,
    waIdentity: null,
    waLid: null,
  });
  if (!to || !adapter.isConfigured()) return fail("no_channel", "Canal sem credencial ou número inválido.", 409);

  try {
    const { externalId } = await adapter.send({
      organizationId,
      sessionRef: resolveSessionRef(session as unknown as Parameters<typeof resolveSessionRef>[0]),
      to,
      kind: "text",
      body,
    });
    return ok({ sent: true, external_id: externalId });
  } catch (err) {
    return fail("send_failed", err instanceof Error ? err.message : "Falha ao enviar.", 502);
  }
}
