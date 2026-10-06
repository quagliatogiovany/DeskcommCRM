# Atualizar o fork a partir do upstream (melgarafael/DeskcommCRM)

Linha real do fork: **`deploy/nodus-sobre-upstream`** (a `main` local é velha, não mergear nela).
Remotos: `origin` = `quagliatogiovany/DeskcommCRM` (fork), `upstream` = `melgarafael/DeskcommCRM`.
Referência de uma atualização inteira: merge da v1.73 em 2026-10-05 (PR #1 e #2 do fork).

**Atualize a cada release do upstream.** Merge pequeno é barato; o de 2.636 commits custou um dia.

## 0. Antes de começar
```
git fetch upstream --tags
git checkout deploy/nodus-sobre-upstream && git pull --ff-only origin deploy/nodus-sobre-upstream
git log --oneline HEAD..upstream/main | wc -l      # tamanho do merge
git diff --stat HEAD...upstream/main -- supabase/baseline.sql | tail -1
```

## 1. Merge numa branch, nunca direto
```
git checkout -b merge/upstream-vX.Y
git merge upstream/main
```
O merge automático **parte blocos do fork** (aconteceu no `baseline.sql`). Depois dele, confira:

1. **`supabase/baseline.sql`**: o bloco do fork (recuperação de clientes + `fn_leads_por_horario`, entre
   a 0416 e a varredura anon) tem de estar INTEIRO e contíguo. Teste: `diff <(git show upstream/main:supabase/baseline.sql) supabase/baseline.sql`
   deve mostrar UMA inserção só. Se vier em dois pedaços, refaça: baseline do upstream + bloco do fork inteiro.
2. **Número das migrations.** O upstream usa números sequenciais e colide com os nossos. Renumere as
   do fork para o próximo livre (hoje 0558–0560) e troque o número nos comentários do baseline, MANIFEST e testes
   (`tests/unit/recuperacao-de-clientes-inativos.test.ts` usa o marcador). O timestamp NÃO muda (é a chave).
   Renumerar é seguro em produção: o `update.sh` reaplica o baseline, que é idempotente.
3. **`git grep -n '<<<<<<<'`** vazio.

## 2. Conferir (rode TUDO que o CI roda — o `tsc` simples NÃO basta)
```
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.typecheck.json
npx eslint . --quiet
npx tsx scripts/lint-channels.ts && npx tsx scripts/lint-role-rank.ts
npx vitest run tests/unit
```
No Windows alguns testes falham SÓ por ambiente: `spawnSync bash ENOENT`, caminho do `pdfjs-dist`, timeouts de 15s,
`agent-version-columns-drift` (separador `\`). Ignore esses; o CI Linux é o juiz.

## 3. Cercas do upstream que o código do fork costuma quebrar
| Cerca | O que fazer |
|---|---|
| `i18n-espanhol-cobre-a-tela` | `t("...")` novo precisa de linha em `lib/i18n/dicionario.ts`. `t(variável)` não pode: use `t()` com literal. |
| `i18n-a-data-segue-o-idioma` | `toLocaleDateString("pt-BR")` fora da camada: `useTagDeIdioma()` ou declarar em `FORA_DE_INTERFACE` (texto que vai pro cliente final). |
| `branding` | Texto "deskcomm" novo: `MARCA_CONGELADA` com categoria. Rotas `api/integrations/deskcomm/*` do Nodus = `PROTOCOLO`. |
| `navegacao-completude` | Tela nova: entrar no `NAV_CATALOG` ou na `NAV_ALLOWLIST` com justificativa. |
| `tailwind-tokens` | `rounded` puro → `rounded-md`. |
| `lint-channels` | Nome de provider fora de `lib/channels/`: declarar em `KNOWN_DEBT` com razão. |
| `dispatcher-org-parada` / `chamadores-do-envio-tratam-org-parada` / `cron-respeita-org-operante` | Handler/cron/chamador de envio novo do fork: registrar com decisão (`naOrgParada`, `idsDeOrgsParadas`). |
| `teto-do-atender-bate-com-a-recusa-da-spec` | O Atender tem 6 `nodus_*` (do fork). Seed do e2e = 5, não 11. Se o upstream mexer no pacote/teto, recalcule: seed + pacote marcável = teto + 1. |

## 4. Fechar e publicar
```
git checkout deploy/nodus-sobre-upstream && git merge --ff-only merge/upstream-vX.Y   # ou PR
git push origin deploy/nodus-sobre-upstream
gh workflow run "Publicar imagem Docker (GHCR)" --repo quagliatogiovany/DeskcommCRM --ref deploy/nodus-sobre-upstream
gh run watch <id> --repo quagliatogiovany/DeskcommCRM --exit-status        # --repo é obrigatório
```
Tag da imagem = `deploy-nodus-sobre-upstream`.

## 5. Deploy na VPS (`ssh -p 22022 root@129.121.45.3`, pasta `/root/deskcommcrm`)
**NUNCA rode `hostgator-setup-kit/update.sh`**: ele faz checkout da maior tag `v*` do origin (pode puxar o upstream).
**NÃO crie tag `v*` no fork** pelo mesmo motivo.

1. Do PC (PowerShell): `scp -P 22022 C:\Users\giovany\DeskcommCRM\supabase\baseline.sql root@129.121.45.3:/root/baseline-novo.sql`
2. Na VPS: `docker pull` das 3 imagens (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`, tag `deploy-nodus-sobre-upstream`).
3. `bash hostgator-setup-kit/backup.sh`
4. Baseline (um comando por vez; NÃO `source .env`, NÃO `source _common.sh`):
   ```
   U=$(grep -E '^SUPABASE_DB_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')
   docker run --rm -i -v /root/baseline-novo.sql:/b.sql:ro postgres:17-alpine psql "$U" -f /b.sql > /root/baseline-saida.txt 2>&1
   grep -iE "ERROR|FATAL" /root/baseline-saida.txt | grep -viE "already exists|multiple primary keys|multiple default values|is already a member|already a partition" | head -20
   ```
   Erro real = qualquer linha. `deadlock detected` com app rodando: rode o `docker run` de novo (idempotente).
5. `docker compose -f docker-compose.prod.yml up -d --force-recreate app worker scheduler`, depois `ps` e `logs --tail 25`.

## 6. Armadilhas do terminal
- SSH com senha só funciona numa janela PowerShell própria (o `!` do Claude Code não aceita senha).
- Colar no terminal: `Ctrl+Shift+V` ou botão direito. Linha muito longa trunca: um comando por vez.
- O CI do fork não tem releases: a conferência do `update.sh` é pulada de propósito em fork
  (`scripts/conferir-isolamento-do-kit.sh`).

## 7. Lições do merge da v1.73 (o CI do fork nunca tinha rodado)
- `invariants-majors`: policy de ESCRITA usa `fn_is_platform_admin_full()` (nunca a função pura); tabela nova com
  `organization_id` entra em `TABLES` ou em `PROVA_PROPRIA` (`tests/invariants/rls-completude-varredura.test.ts`).
- `escopo-das-escritas`: ferramenta de escrita do agente fora da tabela `ESCOPO_DAS_ESCRITAS` é RECUSADA no turno.
  Nova ferramenta `nodus_*` de escrita = nova linha lá.
- `nodus_*` no turno usam o telefone do CONTATO da conversa (`telefoneDaChamada`), nunca o do modelo.
- `scripts/checar-colisao-de-migration.sh` mede contra a base do PR (`GITHUB_BASE_REF`); `main` do fork é linha velha.
- `scripts/conferir-isolamento-do-kit.sh` pula em fork (sem releases/tags para comparar).
- Env vazia no `.env.example` + `??` não cai no default: use `process.env.X?.trim() || "default"`.
