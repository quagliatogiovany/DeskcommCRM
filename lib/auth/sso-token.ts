/**
 * Stateless HMAC-SHA256 SSO token — a ponte servidor-a-servidor da Fase 5 do
 * CRM externo (`docs/backlog/crm-externo-deskcomm-plano.md` no repo Nodus).
 * Emitido pelo Nodus (`src/lib/deskcommSso.ts` lá), consumido aqui em
 * `app/api/sso/consume/route.ts`. NÃO reusa `INTERNAL_SECRET` nem
 * `INVITE_TOKEN_SECRET` — são domínios de confiança diferentes (o primeiro
 * autentica o BACKEND do Nodus chamando este backend; este token autentica
 * um NAVEGADOR sendo redirecionado, por decisão do Nodus).
 *
 * Formato idêntico ao invite-token.ts: `<body>.<sig>`, body = base64url(JSON),
 * sig = base64url(HMAC_SHA256(secret, body)). O contrato de payload (campos e
 * ORDEM, já que o HMAC cobre o JSON literal) é compartilhado byte a byte com
 * `signSsoToken` do lado Nodus — mexer na forma do objeto aqui exige o mesmo
 * lá.
 *
 * Secret: CRM_SSO_SECRET (mesmo valor nas duas instalações). Produção DEVE
 * setá-la — o fallback é só para dev local sem `.env`.
 */
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = (): string => process.env.CRM_SSO_SECRET ?? "dev-fallback";

export interface SsoPayload {
  organization_id: string;
  email: string;
  name: string | null;
  exp: number; // epoch seconds
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signSsoToken(payload: SsoPayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", SECRET()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySsoToken(token: string): SsoPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", SECRET()).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const checked = z
    .object({
      organization_id: z.string().uuid(),
      email: z.string().email(),
      name: z.string().nullable().optional(),
      exp: z.number().int().positive(),
    })
    .safeParse(payload);
  if (!checked.success) return null;

  if (checked.data.exp * 1000 < Date.now()) return null;
  return { ...checked.data, name: checked.data.name ?? null };
}

/** Curto de propósito: o botão "Abrir CRM" mina o token na hora do clique. */
export const SSO_TTL_SECONDS = 60;
