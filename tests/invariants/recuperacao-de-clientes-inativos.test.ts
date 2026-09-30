import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * A RECUPERAÇÃO DE CLIENTES INATIVOS SÓ ESCREVE POR QUEM PODE, E SÓ COM DADO
 * VÁLIDO (migration 0417).
 *
 * `tests/unit/recuperacao-de-clientes-inativos.test.ts` mede a TRIPLA
 * (migration × apêndice × MANIFEST) com dublê de arquivo — o que ele NÃO
 * alcança é se a RLS e os CHECK realmente valem contra Postgres real. É o que
 * este arquivo mede, em três blocos:
 *
 *   A. RLS de `recuperacao_config`: leitura é por tenant SEM gate de papel
 *      (`viewer` lê), escrita exige `manager` (`viewer` é recusado, `admin`
 *      passa), e nenhuma organização vizinha alcança a linha alheia — nem pra
 *      ler, nem pra escrever.
 *   B. As onze CHECK de `recuperacao_config`: cada uma recusa o valor que ela
 *      existe pra barrar, com o NOME da constraint na mensagem — não um 500
 *      genérico. Uma linha válida no fim prova que as onze juntas não
 *      travam o caso comum.
 *   C. `campaigns.origem`/`rodada_data`: as duas CHECK novas e o índice único
 *      parcial — duas rodadas de recuperação no MESMO dia pra mesma
 *      organização são recusadas, a mesma data em organizações diferentes
 *      não conflita, e campanha manual nem participa da trava.
 *
 * `tests/invariants/rls-isolation.test.ts` (G1-02) é CONGELADO por
 * `loop/hooks/freeze-invariants.sh` — "entram aqui no MESMO commit da
 * migration" valia antes do freeze; hoje a porta pra tabela tenant-aware nova
 * é um arquivo NOVO (o mesmo caminho de
 * `credenciais-de-ia-sao-lidas-por-manager.test.ts`), e por isso o bloco A
 * cobre sozinho o que o `TABLES` daquele arquivo cobriria.
 */

/** Organização de OUTRA barba — o tenant que tenta alcançar a linha do GOV_ORG. */
const ORG_VIZINHA = "dddddddd-0000-4000-8000-000000000001";
const VIZINHA_MANAGER = "dddddddd-1111-4000-8000-000000000001";

/** Organização própria pros CHECK: cada INSERT malformado falha sem sujar linha nenhuma. */
const ORG_CHECKS = "dddddddd-2222-4000-8000-000000000001";
const SESS_CHECKS = "dddddddd-2222-4000-8000-000000000002";

/** Segunda organização, só pro caso "mesma data, tenant diferente, sem conflito". */
const ORG_CHECKS_B = "dddddddd-3333-4000-8000-000000000001";
const SESS_CHECKS_B = "dddddddd-3333-4000-8000-000000000002";

const CAMP_RODADA_A = "dddddddd-4444-4000-8000-000000000001";
const CAMP_RODADA_B = "dddddddd-4444-4000-8000-000000000002";

/** Roda o script como `postgres` (bypassa RLS) e devolve o texto do erro, ou "" se passou. */
function capturarErro(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const err = e as { stderr?: string };
    return err.stderr ?? String(e);
  }
}

/** `select count(*)` como `postgres` — sem RLS, é a verdade-terreno pra comparar com `countAs`. */
function contarComoPostgres(where: string): number {
  return Number(sql(`select count(*) from public.recuperacao_config where ${where};`));
}

function mensagemAtual(org: string): string {
  return sql(`select mensagem from public.recuperacao_config where organization_id = '${org}';`);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${VIZINHA_MANAGER}', 'recuperacao-vizinha@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_VIZINHA}', 'recuperacao-inv-vizinha', 'Recuperação Invariant Vizinha', 'Recuperação Vizinha'),
      ('${ORG_CHECKS}', 'recuperacao-inv-checks', 'Recuperação Invariant Checks', 'Recuperação Checks'),
      ('${ORG_CHECKS_B}', 'recuperacao-inv-checks-b', 'Recuperação Invariant Checks B', 'Recuperação Checks B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${VIZINHA_MANAGER}', '${ORG_VIZINHA}', 'manager', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESS_CHECKS}', '${ORG_CHECKS}', 'recuperacao-inv-checks', '\\x00'::bytea),
      ('${SESS_CHECKS_B}', '${ORG_CHECKS_B}', 'recuperacao-inv-checks-b', '\\x00'::bytea)
      on conflict (id) do nothing;
  `);
});

describe("A — RLS de recuperacao_config (0417)", () => {
  it("viewer NÃO cria linha — o INSERT é recusado pelo WITH CHECK da policy de escrita", () => {
    const linhas = writeCountAs(
      GOV_VIEWER,
      `insert into public.recuperacao_config (organization_id, base_legal) values ('${GOV_ORG}', 'consent')`,
    );
    expect(linhas, "viewer conseguiu criar a configuração — a policy de escrita não exige manager").toBe(0);
    expect(contarComoPostgres(`organization_id = '${GOV_ORG}'`)).toBe(0);
  });

  it("manager cria a linha — é o piso de papel que a rota /api/v1/recuperacao/config cobra", () => {
    const linhas = writeCountAs(
      GOV_MANAGER,
      `insert into public.recuperacao_config (organization_id, base_legal) values ('${GOV_ORG}', 'consent')`,
    );
    expect(linhas, "manager foi recusado — a tela de configuração pararia de salvar").toBe(1);
    expect(contarComoPostgres(`organization_id = '${GOV_ORG}'`)).toBe(1);
  });

  it("viewer LÊ a própria organização — a policy de select não tem gate de papel", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.recuperacao_config where organization_id = '${GOV_ORG}';`)).toBe(1);
  });

  it("viewer NÃO altera a linha existente (UPDATE recusado, 0 linhas, sem erro)", () => {
    const linhas = writeCountAs(
      GOV_VIEWER,
      `update public.recuperacao_config set mensagem = 'tentativa viewer' where organization_id = '${GOV_ORG}'`,
    );
    expect(linhas).toBe(0);
    expect(mensagemAtual(GOV_ORG)).toBe("");
  });

  it("CONTROLE POSITIVO: admin (acima de manager) continua escrevendo", () => {
    const linhas = writeCountAs(
      GOV_ADMIN,
      `update public.recuperacao_config set mensagem = 'ok admin' where organization_id = '${GOV_ORG}'`,
    );
    expect(linhas).toBe(1);
    expect(mensagemAtual(GOV_ORG)).toBe("ok admin");
  });

  it("organização vizinha não LÊ a linha do GOV_ORG (zero linhas, sem erro)", () => {
    expect(
      countAs(VIZINHA_MANAGER, `select count(*) from public.recuperacao_config where organization_id = '${GOV_ORG}';`),
    ).toBe(0);
  });

  it("organização vizinha não ESCREVE na linha do GOV_ORG (manager alheio não basta)", () => {
    const linhas = writeCountAs(
      VIZINHA_MANAGER,
      `update public.recuperacao_config set mensagem = 'invasão' where organization_id = '${GOV_ORG}'`,
    );
    expect(linhas, "manager de OUTRA organização alterou a config do GOV_ORG").toBe(0);
    expect(mensagemAtual(GOV_ORG)).toBe("ok admin");
  });
});

describe("B — CHECK constraints de recuperacao_config (0417)", () => {
  it("dias_sem_pedido fora de 1..3650 é recusado", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, dias_sem_pedido)
       values ('${ORG_CHECKS}', 'consent', 0);`,
    );
    expect(erro).toContain("recuperacao_config_dias_sem_pedido_check");
  });

  it("nao_repetir_antes_dias fora de 1..3650 é recusado", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, nao_repetir_antes_dias)
       values ('${ORG_CHECKS}', 'consent', 3651);`,
    );
    expect(erro).toContain("recuperacao_config_nao_repetir_check");
  });

  it("janela que termina antes (ou junto) de começar é recusada", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, janela_inicio_hora, janela_fim_hora)
       values ('${ORG_CHECKS}', 'consent', 20, 9);`,
    );
    expect(erro).toContain("recuperacao_config_janela_check");
  });

  it("hora_disparo fora de 0..23 é recusada", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, hora_disparo)
       values ('${ORG_CHECKS}', 'consent', 24);`,
    );
    expect(erro).toContain("recuperacao_config_hora_disparo_check");
  });

  it("dia_semana fora de 0..6 é recusado, mesmo em recorrência manual", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, recorrencia, dia_semana)
       values ('${ORG_CHECKS}', 'consent', 'manual', 8);`,
    );
    expect(erro).toContain("recuperacao_config_dia_semana_check");
  });

  it("limite_por_rodada fora de 1..5000 é recusado", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, limite_por_rodada)
       values ('${ORG_CHECKS}', 'consent', 0);`,
    );
    expect(erro).toContain("recuperacao_config_limite_check");
  });

  it("recorrencia fora do vocabulário (manual/diaria/semanal) é recusada", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, recorrencia)
       values ('${ORG_CHECKS}', 'consent', 'mensal');`,
    );
    expect(erro).toContain("recuperacao_config_recorrencia_check");
  });

  it("recorrencia semanal SEM dia_semana é recusada — sem dia, o cron não saberia quando rodar", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, recorrencia, dia_semana)
       values ('${ORG_CHECKS}', 'consent', 'semanal', null);`,
    );
    expect(erro).toContain("recuperacao_config_semanal_exige_dia");
  });

  it("base_legal fora do vocabulário (consent/legitimate_interest) é recusada", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal)
       values ('${ORG_CHECKS}', 'oral');`,
    );
    expect(erro).toContain("recuperacao_config_base_legal_check");
  });

  it("legitimate_interest SEM lia_ref (nulo ou vazio) é recusado — sem ela, ninguém responde a quem perguntar", () => {
    const semRef = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, lia_ref)
       values ('${ORG_CHECKS}', 'legitimate_interest', null);`,
    );
    expect(semRef).toContain("recuperacao_config_lia_ref_check");

    const refVazia = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, lia_ref)
       values ('${ORG_CHECKS}', 'legitimate_interest', '   ');`,
    );
    expect(refVazia).toContain("recuperacao_config_lia_ref_check");
  });

  it("ativo=true SEM canal é recusado — disparo sem número pra sair não é config válida", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config (organization_id, base_legal, ativo, channel_session_id)
       values ('${ORG_CHECKS}', 'consent', true, null);`,
    );
    expect(erro).toContain("recuperacao_config_ativo_exige_canal");
  });

  it("CONTROLE POSITIVO: linha ativa, semanal, com canal e LIA passa — as onze CHECK juntas não travam o caso comum", () => {
    const erro = capturarErro(
      `insert into public.recuperacao_config
         (organization_id, ativo, channel_session_id, base_legal, lia_ref, recorrencia, dia_semana)
       values ('${ORG_CHECKS}', true, '${SESS_CHECKS}', 'legitimate_interest', 'LIA-INVARIANT-0417', 'semanal', 3);`,
    );
    expect(erro, `esperava sucesso: ${erro}`).toBe("");
    expect(contarComoPostgres(`organization_id = '${ORG_CHECKS}'`)).toBe(1);
  });
});

describe("C — campaigns.origem/rodada_data (0417)", () => {
  it("origem fora do vocabulário (manual/recuperacao) é recusada", () => {
    const erro = capturarErro(
      `insert into public.campaigns (organization_id, name, channel_session_id, base_legal, origem)
       values ('${ORG_CHECKS}', 'Camp inv origem', '${SESS_CHECKS}', 'consent', 'zap');`,
    );
    expect(erro).toContain("campaigns_origem_check");
  });

  it("origem=recuperacao SEM rodada_data é recusada — é a chave da unicidade diária", () => {
    const erro = capturarErro(
      `insert into public.campaigns (organization_id, name, channel_session_id, base_legal, origem)
       values ('${ORG_CHECKS}', 'Camp inv sem rodada', '${SESS_CHECKS}', 'consent', 'recuperacao');`,
    );
    expect(erro).toContain("campaigns_recuperacao_exige_rodada_data");
  });

  it("CONTROLE POSITIVO: origem=recuperacao COM rodada_data cria a campanha", () => {
    const erro = capturarErro(
      `insert into public.campaigns (id, organization_id, name, channel_session_id, base_legal, origem, rodada_data)
       values ('${CAMP_RODADA_A}', '${ORG_CHECKS}', 'Camp inv rodada A', '${SESS_CHECKS}', 'consent', 'recuperacao', '2026-09-29');`,
    );
    expect(erro, `esperava sucesso: ${erro}`).toBe("");
  });

  it("uma SEGUNDA rodada de recuperação no MESMO dia, MESMA organização, é recusada (índice único)", () => {
    const erro = capturarErro(
      `insert into public.campaigns (organization_id, name, channel_session_id, base_legal, origem, rodada_data)
       values ('${ORG_CHECKS}', 'Camp inv rodada A duplicada', '${SESS_CHECKS}', 'consent', 'recuperacao', '2026-09-29');`,
    );
    expect(
      erro,
      "duas rodadas de recuperação no mesmo dia passaram — reinício de worker ou dois nós duplicariam o disparo",
    ).toContain("campaigns_recuperacao_uma_por_dia_uidx");
  });

  it("a MESMA data em organização DIFERENTE não conflita — a trava é por tenant", () => {
    const erro = capturarErro(
      `insert into public.campaigns (id, organization_id, name, channel_session_id, base_legal, origem, rodada_data)
       values ('${CAMP_RODADA_B}', '${ORG_CHECKS_B}', 'Camp inv rodada B', '${SESS_CHECKS_B}', 'consent', 'recuperacao', '2026-09-29');`,
    );
    expect(erro, `esperava sucesso: ${erro}`).toBe("");
  });

  it("campanha manual nem participa da trava: duas coexistem sem rodada_data no mesmo dia/organização", () => {
    const erro = capturarErro(
      `insert into public.campaigns (organization_id, name, channel_session_id, base_legal, origem) values
         ('${ORG_CHECKS}', 'Camp inv manual 1', '${SESS_CHECKS}', 'consent', 'manual'),
         ('${ORG_CHECKS}', 'Camp inv manual 2', '${SESS_CHECKS}', 'consent', 'manual');`,
    );
    expect(erro, `esperava sucesso: ${erro}`).toBe("");
    expect(Number(sql(`select count(*) from public.campaigns where organization_id = '${ORG_CHECKS}' and origem = 'manual';`))).toBe(2);
  });
});
