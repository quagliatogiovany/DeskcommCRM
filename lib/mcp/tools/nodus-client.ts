/**
 * Cliente HTTP compartilhado das tools `nodus_*` (Fase 4 —
 * docs/backlog/crm-externo-deskcomm-plano.md no repo do Nodus).
 *
 * Cada tool é um `fetch` fino pra `app/api/integrations/deskcomm/*` do Nodus,
 * autenticado com a chave da PRÓPRIA organização (`organizations.nodus_api_key`,
 * migration 0239 — espelho do `Empresa.deskcommApiKey` de lá). A URL é uma
 * só (`NODUS_BASE_URL`, uma instalação do Nodus atende todas as lojas); o
 * segredo não é — daí ler a chave do banco por `ctx.organizationId`, nunca de
 * env global.
 */
import type { McpContext } from "../types";

export class NodusApiError extends Error {
  constructor(
    message: string,
    public code: string | null,
    public status: number,
  ) {
    super(message);
  }
}

async function nodusApiKey(ctx: McpContext): Promise<string> {
  const { data, error } = await ctx.supabase
    .from("organizations")
    .select("nodus_api_key")
    .eq("id", ctx.organizationId)
    .single();

  if (error) throw new Error(`nodus_org_lookup_falhou: ${error.message}`);
  if (!data?.nodus_api_key) {
    throw new Error(
      "nodus_nao_configurado: esta organização não tem nodus_api_key cadastrada (ver migration 0239).",
    );
  }
  return data.nodus_api_key as string;
}

export async function nodusRequest(
  ctx: McpContext,
  opts: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const baseUrl = process.env.NODUS_BASE_URL;
  if (!baseUrl) throw new Error("nodus_nao_configurado: env NODUS_BASE_URL ausente");

  const apiKey = await nodusApiKey(ctx);

  const url = new URL(opts.path, `${baseUrl.replace(/\/$/, "")}/`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: opts.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const parsed: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const code = typeof obj.code === "string" ? obj.code : null;
    const message = typeof obj.error === "string" ? obj.error : `HTTP ${res.status}`;
    throw new NodusApiError(message, code, res.status);
  }

  return parsed;
}

/**
 * Traduz o `code` de negócio que `agentApi.ts` do Nodus devolve numa
 * explicação que o modelo consegue agir em cima — o mesmo espírito de
 * `avisosDaBusca` em `comercio.ts`. Estados esperados da conversa, não bugs:
 * por isso os handlers das tools devolvem isto como resultado normal
 * (`sucesso: false`), não como erro de ferramenta.
 *
 * `NAO_ATIVO`/`PRECISA_CODIGO` existem porque o Nodus só libera catálogo e
 * pedido pra cliente com cadastro ativo (indicação + dados) — fluxo que as
 * tools `validar_codigo_indicacao`/`ativar_cliente` cobririam, e que ficou
 * fora do escopo da Fase 4 (só consulta/pedido/status). Até essas tools
 * existirem, um contato novo esbarra aqui.
 */
export function mensagemParaCodigoNodus(code: string | null, fallback: string): string {
  switch (code) {
    case "NAO_ATIVO":
    case "PRECISA_CODIGO":
      return (
        "Este cliente ainda não tem cadastro liberado na loja (Nodus exige indicação + " +
        "cadastro antes de comprar, e o agente ainda não tem essa ferramenta). Explique que " +
        "o cadastro precisa ser feito pelo link do catálogo da loja, ou chame um humano."
      );
    case "LOJA_FECHADA":
      return "A loja está fechada agora. Informe o horário de reabertura, se souber, e não insista no pedido.";
    case "PLANO_INVALIDO":
      return "Esta loja só atende pedido direto por WhatsApp no momento, não por este canal.";
    case "SEM_ITENS":
      return "O pedido não tem itens. Confirme com o cliente o que ele quer antes de tentar de novo.";
    case "PRODUTO_INVALIDO":
      return "Um dos produtos informados não existe (ou não está à venda) no catálogo da loja. Use nodus_consultar_catalogo antes de montar o pedido.";
    case "ABAIXO_DO_MINIMO":
      return fallback; // já vem com o valor mínimo formatado, dito ao cliente é o suficiente.
    case "SEM_ESTOQUE":
      return fallback; // já vem com o nome do produto sem estoque.
    default:
      return fallback;
  }
}
