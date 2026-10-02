import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * fn_leads_por_horario (migration 0418) — heatmap de dia-da-semana × hora em
 * que o lead entra em contato.
 *
 * Mesmo motivo do `atrito-metrics.test.ts`: o typecheck não vigia nome de RPC
 * nem corpo de SQL — só o Postgres prova que a agregação agrega certo e que a
 * organização vizinha não vaza.
 */

const VIZINHA = "94940000-0000-4000-8000-000000000001";
const SESSION_VIZ = "94940000-0000-4000-8000-0000000000ff";
const CONTATO_VIZ = "94941111-0000-4000-8000-000000000001";
const CONV_VIZ = "94942222-0000-4000-8000-000000000001";

// Timezone inválido salvo direto (a coluna não é validada na escrita —
// lib/tempo/fusos.ts): a função não pode lançar, tem que cair no default.
const ORG_FUSO_INVALIDO = "94940000-0000-4000-8000-000000000002";
const SESSION_FUSO_INVALIDO = "94940000-0000-4000-8000-0000000000fe";
const CONTATO_FUSO_INVALIDO = "94941111-0000-4000-8000-000000000002";
const CONV_FUSO_INVALIDO = "94942222-0000-4000-8000-000000000002";

const CONTATO_IA = "94941111-0000-4000-8000-000000000011";
const CONTATO_HUMANO = "94941111-0000-4000-8000-000000000012";
const CONTATO_SEM_RESPOSTA = "94941111-0000-4000-8000-000000000013";
const CONTATO_EMPRESA_INICIOU = "94941111-0000-4000-8000-000000000014";
const CONTATO_FORA_DA_JANELA = "94941111-0000-4000-8000-000000000015";

const CONV_IA = "94942222-0000-4000-8000-000000000011";
const CONV_HUMANO = "94942222-0000-4000-8000-000000000012";
const CONV_SEM_RESPOSTA = "94942222-0000-4000-8000-000000000013";
const CONV_EMPRESA_INICIOU = "94942222-0000-4000-8000-000000000014";
const CONV_FORA_DA_JANELA = "94942222-0000-4000-8000-000000000015";

const DE = "2026-03-01T00:00:00Z";
const ATE = "2026-04-01T00:00:00Z";

// 13h UTC → 10h em America/Sao_Paulo (UTC-3, sem horário de verão desde 2019).
// A prova da conversão de fuso não depende de saber o dia da semana de cabeça.
const CHEGOU_13H_UTC = "2026-03-05T13:00:00Z";

function leadsPorHorarioComo(
  userId: string,
  org: string,
): { timezone: string; grade: { dow: number; hora: number; leads: number; respondidos: number; sem_resposta: number }[]; por_hora: unknown[] } {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select public.fn_leads_por_horario('${org}'::uuid, '${DE}'::timestamptz, '${ATE}'::timestamptz);
  `);
  return JSON.parse(lastLine(out));
}

function totalLeads(grade: { leads: number }[]): number {
  return grade.reduce((acc, c) => acc + c.leads, 0);
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.messages where conversation_id in
      ('${CONV_VIZ}', '${CONV_FUSO_INVALIDO}', '${CONV_IA}', '${CONV_HUMANO}',
       '${CONV_SEM_RESPOSTA}', '${CONV_EMPRESA_INICIOU}', '${CONV_FORA_DA_JANELA}');
    delete from public.conversations where id in
      ('${CONV_VIZ}', '${CONV_FUSO_INVALIDO}', '${CONV_IA}', '${CONV_HUMANO}',
       '${CONV_SEM_RESPOSTA}', '${CONV_EMPRESA_INICIOU}', '${CONV_FORA_DA_JANELA}');
    delete from public.contacts where id in
      ('${CONTATO_VIZ}', '${CONTATO_FUSO_INVALIDO}', '${CONTATO_IA}', '${CONTATO_HUMANO}',
       '${CONTATO_SEM_RESPOSTA}', '${CONTATO_EMPRESA_INICIOU}', '${CONTATO_FORA_DA_JANELA}');
    delete from public.channel_sessions where id in ('${SESSION_VIZ}', '${SESSION_FUSO_INVALIDO}');
    delete from public.user_organizations where user_id = '${GOV_AGENT_A}' and organization_id = '${ORG_FUSO_INVALIDO}';
    delete from public.organizations where id in ('${VIZINHA}', '${ORG_FUSO_INVALIDO}');
  `);
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${VIZINHA}', 'lph-vizinha', 'Vizinha LPH', 'Vizinha');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_VIZ}', '${VIZINHA}', 'lph-viz', '\\x00'::bytea);
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_VIZ}', '${VIZINHA}', 'Contato Vizinho');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_VIZ}', '${VIZINHA}', '${CONTATO_VIZ}', '${SESSION_VIZ}', 'open');
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values ('${VIZINHA}', '${CONV_VIZ}', '${SESSION_VIZ}', '${CONTATO_VIZ}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}');

    -- Organização com fuso que o Postgres RECUSA (sem validação na escrita —
    -- lib/tempo/fusos.ts): a função tem que cair em America/Sao_Paulo, não lançar.
    insert into public.organizations (id, slug, legal_name, display_name, timezone)
      values ('${ORG_FUSO_INVALIDO}', 'lph-fuso-invalido', 'Fuso Invalido LPH', 'Fuso Inválido', 'America/Asunción');
    -- GOV_AGENT_A precisa ser MEMBRO desta org, senão a RLS de messages/
    -- conversations esconde as linhas dela mesmo com p_org certo (é a mesma
    -- causa do teste de isolamento abaixo — RLS, não a função).
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GOV_AGENT_A}', '${ORG_FUSO_INVALIDO}', 'agent', now());
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_FUSO_INVALIDO}', '${ORG_FUSO_INVALIDO}', 'lph-fuso-invalido', '\\x00'::bytea);
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_FUSO_INVALIDO}', '${ORG_FUSO_INVALIDO}', 'Contato Fuso Invalido');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_FUSO_INVALIDO}', '${ORG_FUSO_INVALIDO}', '${CONTATO_FUSO_INVALIDO}', '${SESSION_FUSO_INVALIDO}', 'open');
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values ('${ORG_FUSO_INVALIDO}', '${CONV_FUSO_INVALIDO}', '${SESSION_FUSO_INVALIDO}', '${CONTATO_FUSO_INVALIDO}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}');

    -- GOV_ORG: os cinco casos.
    insert into public.contacts (id, organization_id, display_name)
      values
        ('${CONTATO_IA}', '${GOV_ORG}', 'Respondido pela IA'),
        ('${CONTATO_HUMANO}', '${GOV_ORG}', 'Respondido por humano'),
        ('${CONTATO_SEM_RESPOSTA}', '${GOV_ORG}', 'Sem resposta'),
        ('${CONTATO_EMPRESA_INICIOU}', '${GOV_ORG}', 'Empresa iniciou'),
        ('${CONTATO_FORA_DA_JANELA}', '${GOV_ORG}', 'Fora da janela');

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values
        ('${CONV_IA}', '${GOV_ORG}', '${CONTATO_IA}', '${GOV_SESSION}', 'open'),
        ('${CONV_HUMANO}', '${GOV_ORG}', '${CONTATO_HUMANO}', '${GOV_SESSION}', 'open'),
        ('${CONV_SEM_RESPOSTA}', '${GOV_ORG}', '${CONTATO_SEM_RESPOSTA}', '${GOV_SESSION}', 'open'),
        ('${CONV_EMPRESA_INICIOU}', '${GOV_ORG}', '${CONTATO_EMPRESA_INICIOU}', '${GOV_SESSION}', 'open'),
        ('${CONV_FORA_DA_JANELA}', '${GOV_ORG}', '${CONTATO_FORA_DA_JANELA}', '${GOV_SESSION}', 'open');

    -- IA respondeu 120s depois.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_IA}', '${GOV_SESSION}', '${CONTATO_IA}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}'),
      ('${GOV_ORG}', '${CONV_IA}', '${GOV_SESSION}', '${CONTATO_IA}', 'text', 'outbound', 'sent', 'ai', '2026-03-05T13:02:00Z');

    -- Humano respondeu 10min depois (external_device = celular, também conta como humano).
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_HUMANO}', '${GOV_SESSION}', '${CONTATO_HUMANO}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}'),
      ('${GOV_ORG}', '${CONV_HUMANO}', '${GOV_SESSION}', '${CONTATO_HUMANO}', 'text', 'outbound', 'sent', 'external_device', '2026-03-05T13:10:00Z');

    -- Chegou e ninguém respondeu.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_SEM_RESPOSTA}', '${GOV_SESSION}', '${CONTATO_SEM_RESPOSTA}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}');

    -- A EMPRESA abriu a conversa (outbound ANTES do inbound) — não é "lead entrou em contato".
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_EMPRESA_INICIOU}', '${GOV_SESSION}', '${CONTATO_EMPRESA_INICIOU}', 'text', 'outbound', 'sent', 'automation', '2026-03-05T12:00:00Z'),
      ('${GOV_ORG}', '${CONV_EMPRESA_INICIOU}', '${GOV_SESSION}', '${CONTATO_EMPRESA_INICIOU}', 'text', 'inbound', 'received', 'crm', '${CHEGOU_13H_UTC}');

    -- Primeira mensagem FORA da janela [DE, ATE) — não entra na grade.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_FORA_DA_JANELA}', '${GOV_SESSION}', '${CONTATO_FORA_DA_JANELA}', 'text', 'inbound', 'received', 'crm', '2026-02-15T13:00:00Z');
  `);
});

describe("fn_leads_por_horario — a grade", () => {
  it("13h UTC cai em 10h em America/Sao_Paulo (UTC-3)", () => {
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    const horasComLead = [...new Set(grade.filter((c) => c.leads > 0).map((c) => c.hora))];
    expect(horasComLead).toEqual([10]);
  });

  it("conta os 3 contatos iniciados por CLIENTE na janela — não os outros 2", () => {
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    // IA, humano e sem-resposta contam; "empresa iniciou" e "fora da janela" não.
    expect(totalLeads(grade)).toBe(3);
  });

  it("conversa cuja 1ª mensagem de todas foi OUTBOUND não conta como lead", () => {
    // Controle direto do caso acima: se a função contasse por "tem inbound na
    // janela" em vez de "a 1ª mensagem da vida foi inbound", daria 4, não 3.
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    expect(totalLeads(grade)).toBeLessThan(4);
  });

  it("respondidos soma IA + humano; sem_resposta é o resto", () => {
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    const balde = grade.find((c) => c.hora === 10)!;
    expect(balde.leads).toBe(3);
    expect(balde.respondidos).toBe(2);
    expect(balde.sem_resposta).toBe(1);
  });

  it("o fuso devolvido é o da organização", () => {
    const { timezone } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    expect(timezone).toBe("America/Sao_Paulo");
  });
});

describe("fn_leads_por_horario — isolamento entre organizações", () => {
  it("usuário da org A pedindo p_org da vizinha recebe ZERO, não os dados dela", () => {
    // GOV_AGENT_A não é membro da vizinha: a RLS de messages/conversations
    // (fn_user_org_ids()) já esconde as linhas dela antes de qualquer CTE da
    // função rodar — SECURITY INVOKER faz esse trabalho sem a função precisar
    // confiar só no próprio filtro de p_org. Mesmo desenho e mesma expectativa
    // de `atrito-metrics.test.ts` ("recebe ZERO, não os dados dela").
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, VIZINHA);
    expect(totalLeads(grade)).toBe(0);
  });
});

describe("fn_leads_por_horario — fuso inválido não derruba a rota", () => {
  it("timezone que o Postgres recusa cai em America/Sao_Paulo, sem lançar", () => {
    const resultado = leadsPorHorarioComo(GOV_AGENT_A, ORG_FUSO_INVALIDO);
    expect(resultado.timezone).toBe("America/Sao_Paulo");
    const horasComLead = [...new Set(resultado.grade.filter((c) => c.leads > 0).map((c) => c.hora))];
    expect(horasComLead).toEqual([10]);
  });
});

describe("fn_leads_por_horario — grants (migration 0418, item 9 da doutrina)", () => {
  it("anon NÃO executa — revoke all from public, anon", () => {
    expect(() =>
      sql(`
        set role anon;
        select public.fn_leads_por_horario('${GOV_ORG}'::uuid, '${DE}'::timestamptz, '${ATE}'::timestamptz);
      `),
    ).toThrow();
  });

  it("authenticated executa — grant execute to authenticated", () => {
    const { grade } = leadsPorHorarioComo(GOV_AGENT_A, GOV_ORG);
    expect(Array.isArray(grade)).toBe(true);
  });
});
