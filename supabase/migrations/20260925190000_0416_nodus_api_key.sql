-- Fase 4 do CRM externo (Nodus): as tools novas em lib/mcp/tools/nodus.ts
-- precisam de um jeito de autenticar contra `app/api/integrations/deskcomm/*`
-- do Nodus (`Authorization: Bearer <deskcommApiKey>`, ver
-- src/lib/agentAuth.ts naquele repo). A URL é uma só (env NODUS_BASE_URL —
-- há uma instalação do Nodus para todas as lojas); o segredo NÃO é: cada
-- organização deste CRM corresponde a UMA loja do Nodus, com sua própria
-- chave. `nodus_api_key` é o espelho, deste lado, do `Empresa.deskcommApiKey`
-- de lá — mesmo padrão (nullable, único, string opaca gerada pelo outro
-- lado). Preenchido manualmente por enquanto: a troca automática de chave no
-- provisionamento fica para quando existir SSO (Fase 5) — Fase 3 já decidiu
-- não mudar nada do lado Nodus nesta fase.
--
-- Idempotente: `add column if not exists`.

alter table public.organizations
  add column if not exists nodus_api_key text;

create unique index if not exists organizations_nodus_api_key_idx
  on public.organizations (nodus_api_key)
  where nodus_api_key is not null;

comment on column public.organizations.nodus_api_key is
  'Espelho do Empresa.deskcommApiKey do Nodus — autentica as tools nodus_* (lib/mcp/tools/nodus.ts) contra app/api/integrations/deskcomm/* daquela loja. Preenchido manualmente até existir SSO (Fase 5).';
