/**
 * A CONFIGURAÇÃO DE RECUPERAÇÃO ESTÁ NOS TRÊS ARTEFATOS, E QUEM ESCREVE
 * CAMPANHA DE RECUPERAÇÃO É SÓ `lib/recuperacao/abrir-rodada.ts` (migration
 * 0417).
 *
 * Doutrina de migrations do repo: toda mudança de schema sai em migration
 * versionada + apêndice idempotente do `baseline.sql` + linha no MANIFEST, e
 * os dois primeiros têm de dizer a MESMA coisa (molde de
 * `teto-de-tokens-ativos-da-organizacao.test.ts`, adaptado pra TABELA em vez
 * de função: aqui não há corpo com `$$`, e as duas constraints de `campaigns`
 * o apêndice reescreve dentro de um `do $$ ... end $$` pra ficar idempotente —
 * a comparação delas é por CLÁUSULA, não por byte).
 *
 * O que este arquivo garante, em ordem:
 *   1. a tripla existe (migration, apêndice, MANIFEST);
 *   2. o corpo da tabela `recuperacao_config` (colunas + CHECK + comment) é o
 *      MESMO na migration e no apêndice — normalizado (comentário `--` e
 *      espaço fora), porque `create table if not exists` já é idempotente e
 *      não precisa de guarda extra;
 *   3. o apêndice entra ANTES da varredura de anon;
 *   4. as onze CHECK constraints de `recuperacao_config` existem nos DOIS
 *      artefatos, com o mesmo nome e a mesma cláusula;
 *   5. RLS: select por tenant (ou platform_admin), write exige `manager`,
 *      `revoke all` de anon/authenticated ANTES do `grant select`;
 *   6. `campaigns.origem`/`rodada_data` + as duas CHECK + o índice único
 *      parcial existem nos dois artefatos (a de `campaigns` no apêndice vem
 *      dentro de um `do $$` que testa `pg_constraint` antes de adicionar —
 *      idempotência que a migration não precisa, porque roda uma vez só);
 *   7. os cinco códigos de erro do módulo estão declarados no catálogo;
 *   8. as três rotas (`config`, `previa`, `disparar`) exigem `manager` e
 *      escrevem/leem com o client admin — nunca a sessão do usuário;
 *   9. quem abre campanha com `origem: "recuperacao"` é só
 *      `lib/recuperacao/abrir-rodada.ts` — a rota pública de campanhas
 *      (`POST /api/v1/campaigns`) nunca repassa `origem`/`rodadaData` do
 *      corpo da requisição pra `criarCampanha`.
 *
 * Os casos de comportamento (RLS de verdade barrando `viewer`, os onze CHECK
 * recusando valor inválido, o índice único recusando duplicata) são de
 * POSTGRES REAL e estão em
 * `tests/invariants/recuperacao-de-clientes-inativos.test.ts` — CHECK e RLS
 * não se testam com dublê.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRACAO = "supabase/migrations/20260929200000_0559_recuperacao_de_clientes.sql";
const ler = (caminho: string): string => readFileSync(join(process.cwd(), caminho), "utf8");

const migration = ler(MIGRACAO);
const baseline = ler("supabase/baseline.sql");
const manifest = ler("supabase/migrations/MANIFEST.md");
const rotaConfig = ler("app/api/v1/recuperacao/config/route.ts");
const rotaPrevia = ler("app/api/v1/recuperacao/previa/route.ts");
const rotaDisparar = ler("app/api/v1/recuperacao/disparar/route.ts");
const rotaCampaigns = ler("app/api/v1/campaigns/route.ts");
const abrirRodada = ler("lib/recuperacao/abrir-rodada.ts");
const catalogo = ler("lib/api/errors.ts");

/** Um trecho entre dois marcadores literais (inclusive), ou "" se não achar os dois. */
function trecho(texto: string, inicio: string, fim: string): string {
  const i = texto.indexOf(inicio);
  if (i === -1) return "";
  const f = texto.indexOf(fim, i + inicio.length);
  if (f === -1) return "";
  return texto.slice(i, f + fim.length);
}

/** Comentário `--` e espaço fora — como o Postgres vê o comando. */
function normalizado(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

const TABELA_MIGRATION = normalizado(
  trecho(
    migration,
    "create table if not exists public.recuperacao_config",
    "grant all on public.recuperacao_config to service_role;",
  ),
);
const TABELA_BASELINE = normalizado(
  trecho(
    baseline,
    "create table if not exists public.recuperacao_config",
    "grant all on public.recuperacao_config to service_role;",
  ),
);

const apendice = baseline.indexOf(
  "-- ---- recuperação de clientes inativos: config por organização (migration 0417) ----",
);
const varredura = baseline.indexOf(
  "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----",
);
const bloco = apendice > -1 && varredura > apendice ? baseline.slice(apendice, varredura) : "";

const CHECKS_RECUPERACAO_CONFIG = [
  "recuperacao_config_dias_sem_pedido_check",
  "recuperacao_config_nao_repetir_check",
  "recuperacao_config_janela_check",
  "recuperacao_config_hora_disparo_check",
  "recuperacao_config_dia_semana_check",
  "recuperacao_config_limite_check",
  "recuperacao_config_recorrencia_check",
  "recuperacao_config_semanal_exige_dia",
  "recuperacao_config_base_legal_check",
  "recuperacao_config_lia_ref_check",
  "recuperacao_config_ativo_exige_canal",
] as const;

describe("recuperação de clientes inativos (0417)", () => {
  it("a tripla existe: migration versionada, apêndice no baseline e linha no MANIFEST", () => {
    expect(existsSync(join(process.cwd(), MIGRACAO))).toBe(true);
    expect(apendice, "apêndice da 0417 ausente do baseline.sql").toBeGreaterThan(-1);
    expect(manifest).toMatch(/\| `20260929200000` \| `0559_recuperacao_de_clientes` \|/);
  });

  it("a tabela recuperacao_config é a MESMA na migration e no apêndice do baseline", () => {
    expect(TABELA_MIGRATION.length).toBeGreaterThan(0);
    expect(TABELA_BASELINE).toBe(TABELA_MIGRATION);
  });

  it("o apêndice entra ANTES da varredura de anon (a cerca que não deixa função exposta)", () => {
    expect(varredura).toBeGreaterThan(-1);
    expect(apendice).toBeGreaterThan(-1);
    expect(apendice).toBeLessThan(varredura);
  });

  it("as onze CHECK de recuperacao_config existem, com o mesmo nome, nos dois artefatos", () => {
    for (const nome of CHECKS_RECUPERACAO_CONFIG) {
      expect(migration, `${nome} ausente da migration`).toContain(`constraint ${nome} check`);
      expect(baseline, `${nome} ausente do baseline`).toContain(`constraint ${nome} check`);
    }
  });

  it("RLS: select é por tenant OU platform_admin; write exige manager, nos dois lados", () => {
    for (const artefato of [migration, bloco]) {
      expect(artefato).toContain("recuperacao_config_select");
      expect(artefato).toContain("recuperacao_config_write");
      expect(artefato).toContain("fn_role_at_least(organization_id, 'manager')");
      expect(artefato).toContain("fn_is_platform_admin()");
    }
  });

  it("revoke de anon/authenticated vem ANTES do grant select — nunca a tabela toda aberta", () => {
    for (const artefato of [migration, bloco]) {
      const revoke = artefato.indexOf("revoke all on public.recuperacao_config from anon, authenticated;");
      const grant = artefato.indexOf("grant select on public.recuperacao_config to authenticated;");
      expect(revoke, "revoke ausente").toBeGreaterThan(-1);
      expect(grant, "grant select ausente").toBeGreaterThan(-1);
      expect(revoke).toBeLessThan(grant);
      // anon nunca aparece do lado de um GRANT desta tabela.
      expect(artefato).not.toMatch(/grant [a-z, ]+ on public\.recuperacao_config to anon/);
    }
  });

  it("campaigns.origem/rodada_data + as duas CHECK + o índice único existem nos dois artefatos", () => {
    for (const artefato of [migration, baseline]) {
      expect(artefato).toContain("alter table public.campaigns add column if not exists origem text not null default 'manual';");
      expect(artefato).toContain("alter table public.campaigns add column if not exists rodada_data date;");
      expect(artefato).toContain("check (origem in ('manual', 'recuperacao'))");
      expect(artefato).toContain("check (origem <> 'recuperacao' or rodada_data is not null)");
      expect(artefato).toContain(
        "create unique index if not exists campaigns_recuperacao_uma_por_dia_uidx\n  on public.campaigns (organization_id, rodada_data)\n  where origem = 'recuperacao';",
      );
    }
    // No apêndice as duas constraints entram guardadas por `pg_constraint` —
    // idempotência que a migration (roda uma vez só) não precisa.
    expect(bloco).toContain("select 1 from pg_constraint where conname = 'campaigns_origem_check'");
    expect(bloco).toContain("select 1 from pg_constraint where conname = 'campaigns_recuperacao_exige_rodada_data'");
  });

  it("os cinco códigos do módulo estão declarados no catálogo de erros", () => {
    for (const codigo of [
      "recuperacao_config_invalida",
      "recuperacao_nao_configurada",
      "recuperacao_nao_configurada_no_nodus",
      "recuperacao_sem_inativos",
      "recuperacao_rodada_ja_aberta_hoje",
    ]) {
      expect(catalogo, `${codigo} ausente de lib/api/errors.ts`).toMatch(
        new RegExp(`${codigo}:\\s*"${codigo}"`),
      );
    }
  });

  it("as três rotas exigem manager e leem/escrevem com o client admin", () => {
    for (const [nome, rota] of [
      ["config", rotaConfig],
      ["previa", rotaPrevia],
      ["disparar", rotaDisparar],
    ] as const) {
      expect(rota, `${nome}: sem requireRole("manager")`).toContain('requireRole("manager"');
      expect(rota, `${nome}: sem createAdminClient()`).toContain("createAdminClient()");
    }
  });

  it("só abrir-rodada.ts abre campanha com origem 'recuperacao' — a rota pública nunca repassa", () => {
    expect(abrirRodada).toContain('origem: "recuperacao"');

    // A rota extrai campos NOMEADOS do corpo validado (`entrada`) pra montar o
    // objeto de `criarCampanha` — nunca um spread que deixaria `origem`/
    // `rodadaData` do corpo da requisição vazar pra dentro.
    const chamada = trecho(rotaCampaigns, "criarCampanha(supabase, org.orgId, {", "});");
    expect(chamada.length, "chamada a criarCampanha não encontrada em POST /api/v1/campaigns").toBeGreaterThan(0);
    expect(chamada).not.toContain("...entrada");
    expect(chamada).not.toContain("origem:");
    expect(chamada).not.toContain("rodadaData:");

    // E o schema que valida o corpo não aceita a chave — defesa em profundidade:
    // mesmo que a rota um dia espalhasse `entrada`, o zod já teria descartado.
    const schemas = ler("lib/campanhas/schemas.ts");
    const criarSchema = trecho(schemas, "export const criarCampanhaSchema", "path: [\"janela_fim_hora\"] },\n  );");
    expect(criarSchema).not.toContain("origem:");
    expect(criarSchema).not.toContain("rodada_data:");
  });
});
