-- 0560 — Horário e dia da semana em que o lead entra em contato.
--
-- Pedido do dono do produto: saber EM QUE HORÁRIO os leads chegam, para decidir
-- cobertura de atendimento. A pergunta já tinha consulta de analista pronta
-- (`.claude/skills/deskcomm-metricas/references/consultas.md`, P1 + A1), mas só
-- rodava por SQL direto contra o banco — não existia número correspondente na
-- tela. Esta migration cria a função que a tela `Desempenho` passa a chamar.
--
-- "Lead entrou em contato" = a conversa cuja PRIMEIRA mensagem de toda a vida
-- dela foi INBOUND (o cliente que iniciou — não uma campanha/empresa abrindo a
-- conversa). Grupos ficam de fora, mesmo critério das demais funções de
-- métrica (`fn_attendant_metrics`, `fn_atrito_metrics`).
--
-- Dois recortes no mesmo retorno: a GRADE dia-da-semana × hora (o heatmap de
-- quando o lead chega) e POR_HORA (mediana de resposta por IA e por humano,
-- só por hora — cruzar com dia da semana também deixaria cada balde pequeno
-- demais para a mediana dizer algo).
--
-- Fuso: `organizations.timezone` não é validado na escrita (ver
-- `lib/tempo/fusos.ts`) — um valor que o Postgres recusa faria `at time zone`
-- lançar e a rota inteira cair. Confere contra `pg_timezone_names` e cai em
-- America/Sao_Paulo quando o valor salvo não existe, mesmo default de
-- `FUSO_PADRAO`.
--
-- SECURITY INVOKER (default, sem `security definer`): roda com o client de
-- sessão, então `messages`/`conversations` já filtram por `fn_user_org_ids()`
-- — mesmo desenho das funções irmãs. `p_org` ainda assim filtra cada CTE
-- explicitamente (defesa em profundidade, e único jeito de reaproveitar nos
-- testes com client admin).
create or replace function public.fn_leads_por_horario(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz
) returns jsonb
language sql stable
set search_path = public
as $$
  with fuso as (
    select coalesce(
      (select o.timezone from public.organizations o
        where o.id = p_org
          and o.timezone in (select name from pg_timezone_names)),
      'America/Sao_Paulo'
    ) as tz
  ),
  primeiro_contato as (
    select m.conversation_id,
           (array_agg(m.sent_at order by m.sent_at))[1] as chegou_em,
           (array_agg(m.direction order by m.sent_at))[1] as primeira_direcao
      from public.messages m
      join public.conversations c
        on c.id = m.conversation_id and c.organization_id = m.organization_id
     where m.organization_id = p_org
       and c.is_group = false
     group by m.conversation_id
  ),
  janela as (
    select conversation_id, chegou_em
      from primeiro_contato
     where primeira_direcao = 'inbound'
       and chegou_em >= p_from and chegou_em < p_to
  ),
  resposta as (
    select j.conversation_id, j.chegou_em,
           min(m.sent_at) filter (where m.direction = 'outbound' and m.sent_via = 'ai') as resp_ia,
           min(m.sent_at) filter (
             where m.direction = 'outbound' and m.sent_via in ('user', 'external_device')
           ) as resp_humano
      from janela j
      join public.messages m
        on m.conversation_id = j.conversation_id and m.organization_id = p_org
     group by j.conversation_id, j.chegou_em
  ),
  r_tz as (
    select r.*, (r.chegou_em at time zone fuso.tz) as chegou_em_local
      from resposta r, fuso
  ),
  grade as (
    select extract(isodow from chegou_em_local)::int as dow,
           extract(hour from chegou_em_local)::int as hora,
           count(*) as leads,
           count(*) filter (where resp_ia is not null or resp_humano is not null) as respondidos,
           count(*) filter (where resp_ia is null and resp_humano is null) as sem_resposta
      from r_tz
     group by 1, 2
  ),
  por_hora as (
    select extract(hour from chegou_em_local)::int as hora,
           count(*) as leads,
           percentile_cont(0.5) within group (
             order by extract(epoch from (resp_ia - chegou_em))
           ) filter (where resp_ia is not null) as p50_resposta_ia_s,
           percentile_cont(0.5) within group (
             order by extract(epoch from (resp_humano - chegou_em))
           ) filter (where resp_humano is not null) as p50_resposta_humano_s,
           count(*) filter (where resp_ia is null and resp_humano is null) as sem_resposta
      from r_tz
     group by 1
  )
  select jsonb_build_object(
    'timezone', (select tz from fuso),
    'grade', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'dow', dow, 'hora', hora, 'leads', leads,
          'respondidos', respondidos, 'sem_resposta', sem_resposta
        ) order by dow, hora
      ) from grade
    ), '[]'::jsonb),
    'por_hora', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'hora', hora, 'leads', leads,
          'p50_resposta_ia_s', p50_resposta_ia_s,
          'p50_resposta_humano_s', p50_resposta_humano_s,
          'sem_resposta', sem_resposta
        ) order by hora
      ) from por_hora
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_leads_por_horario(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_leads_por_horario(uuid, timestamptz, timestamptz) to authenticated, service_role;
