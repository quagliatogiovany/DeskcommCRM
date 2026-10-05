-- 0559 — RECUPERAÇÃO DE CLIENTES INATIVOS (ponte com o Nodus)
--
-- Cada organização liga a loja dela no Nodus (`organizations.nodus_api_key`,
-- migration 0558). Esta migration guarda a CONFIGURAÇÃO por organização de um
-- disparo de WhatsApp pra quem parou de pedir — quantos dias sem pedir conta
-- como inativo, o texto, o horário permitido, se roda sozinho ou só manual.
-- O motor de envio é o de Campanhas que já existe (migration 0375): a
-- recuperação apenas ABRE uma campanha com `audience_filter.incluir_contatos`
-- e variáveis extras (`dias_sem_pedir`, `ultimo_pedido`) vindas do Nodus —
-- não é um sistema de envio novo.
--
-- ═══ Por que config é tabela própria, e não `organizations.settings` ═══
--
-- `organizations.settings` tem vários escritores concorrentes (branding,
-- segurança, campanhas...) e um `update({settings})` ingênuo já causou
-- regressão por sobrescrever campo alheio (ver `updateMarcaDaOrganizacao.ts`).
-- Configuração nova ganha coluna própria, não mais uma chave num jsonb
-- compartilhado.
--
-- ═══ Por que `campaigns.origem` + `rodada_data`, e não só o cron ═══
--
-- O cron roda de hora em hora e não pode ser a única trava contra duplicar —
-- reinício do worker, retry de infra ou dois nós rodando o mesmo minuto
-- disparariam duas campanhas de recuperação no mesmo dia pro mesmo cliente.
-- A UNICIDADE mora no banco: uma campanha de origem 'recuperacao' por
-- organização por dia, e ponto.

create table if not exists public.recuperacao_config (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ativo boolean not null default false,
  dias_sem_pedido integer not null default 30,
  nao_repetir_antes_dias integer not null default 30,
  mensagem text not null default '',
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  janela_inicio_hora smallint not null default 9,
  janela_fim_hora smallint not null default 20,
  recorrencia text not null default 'manual',
  dia_semana smallint,
  hora_disparo smallint not null default 10,
  limite_por_rodada integer not null default 500,
  base_legal text not null default 'legitimate_interest',
  lia_ref text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recuperacao_config_dias_sem_pedido_check check (dias_sem_pedido between 1 and 3650),
  constraint recuperacao_config_nao_repetir_check check (nao_repetir_antes_dias between 1 and 3650),
  constraint recuperacao_config_janela_check check (
    janela_inicio_hora between 0 and 23 and janela_fim_hora between 0 and 23
    and janela_inicio_hora < janela_fim_hora
  ),
  constraint recuperacao_config_hora_disparo_check check (hora_disparo between 0 and 23),
  constraint recuperacao_config_dia_semana_check check (dia_semana is null or dia_semana between 0 and 6),
  constraint recuperacao_config_limite_check check (limite_por_rodada between 1 and 5000),
  constraint recuperacao_config_recorrencia_check check (recorrencia in ('manual', 'diaria', 'semanal')),
  constraint recuperacao_config_semanal_exige_dia check (recorrencia <> 'semanal' or dia_semana is not null),
  constraint recuperacao_config_base_legal_check check (base_legal in ('consent', 'legitimate_interest')),
  constraint recuperacao_config_lia_ref_check check (
    base_legal <> 'legitimate_interest' or btrim(coalesce(lia_ref, '')) <> ''
  ),
  -- Ativar sem canal escolhido dispararia campanha sem número pra sair.
  constraint recuperacao_config_ativo_exige_canal check (not ativo or channel_session_id is not null)
);

comment on table public.recuperacao_config is
  'Configuração por organização do disparo de recuperação de clientes inativos (issue: recuperação de clientes, 2026-09-29). Uma linha por organização; nasce só quando o dono mexe na tela pela primeira vez — ausência de linha = recuperação nunca configurada.';
comment on column public.recuperacao_config.dias_sem_pedido is
  'Cliente sem pedido há pelo menos estes dias entra na rodada. Consultado contra o Nodus (POST .../deskcomm/clientes-inativos), nunca contra dado local — o Nodus é quem sabe o último pedido.';
comment on column public.recuperacao_config.nao_repetir_antes_dias is
  'Um mesmo cliente não recebe recuperação de novo antes deste prazo, mesmo que continue inativo — veto aplicado na abertura da rodada (lib/recuperacao), somado (não substitui) ao veto padrão de campanha viva.';

drop trigger if exists trg_recuperacao_config_updated_at on public.recuperacao_config;
create trigger trg_recuperacao_config_updated_at
  before update on public.recuperacao_config
  for each row execute function public.fn_set_updated_at();

alter table public.recuperacao_config enable row level security;

drop policy if exists recuperacao_config_select on public.recuperacao_config;
create policy recuperacao_config_select on public.recuperacao_config
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists recuperacao_config_write on public.recuperacao_config;
create policy recuperacao_config_write on public.recuperacao_config
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- Igual a `campaigns` (0375): a tela lê pela sessão; quem escreve é o servidor
-- com o client admin, filtrando `organization_id` explicitamente na aplicação.
revoke all on public.recuperacao_config from anon, authenticated;
grant select on public.recuperacao_config to authenticated;
grant all on public.recuperacao_config to service_role;

-- ═══ campaigns.origem + rodada_data — a idempotência da recuperação ═══

alter table public.campaigns add column if not exists origem text not null default 'manual';
alter table public.campaigns add column if not exists rodada_data date;

alter table public.campaigns
  add constraint campaigns_origem_check check (origem in ('manual', 'recuperacao'));
alter table public.campaigns
  add constraint campaigns_recuperacao_exige_rodada_data check (origem <> 'recuperacao' or rodada_data is not null);

comment on column public.campaigns.origem is
  'De onde a campanha nasceu. ''recuperacao'' = aberta por lib/recuperacao (cron ou botão Disparar agora), nunca criada direto pela rota POST /api/v1/campaigns.';
comment on column public.campaigns.rodada_data is
  'Só em origem=recuperacao: a data (fuso da organização) desta rodada. Par com a unicidade abaixo — impede duas rodadas de recuperação no mesmo dia por organização, mesmo com cron duplicado ou reiniciado.';

create unique index if not exists campaigns_recuperacao_uma_por_dia_uidx
  on public.campaigns (organization_id, rodada_data)
  where origem = 'recuperacao';
