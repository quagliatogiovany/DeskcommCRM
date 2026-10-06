/**
 * O telefone das ferramentas `nodus_*` dentro do turno de um agente é o do CONTATO da conversa,
 * nunca o que o modelo escreveu (backlog `crm-ferramentas-nodus-telefone-livre`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const nodusRequest = vi.fn(async (..._args: unknown[]) => ({ pedidos: [], produtos: [], ok: true }));

vi.mock("./nodus-client", () => ({
  nodusRequest: (...args: unknown[]) => nodusRequest(...args),
  NodusApiError: class NodusApiError extends Error {
    code = "X";
  },
  mensagemParaCodigoNodus: (_c: string, m: string) => m,
}));

import type { McpContext } from "../types";
import {
  nodusAtivarCliente,
  nodusConsultarCatalogo,
  nodusCriarPedido,
  nodusSolicitarCancelamento,
  nodusStatusPedido,
  nodusValidarCodigoIndicacao,
} from "./nodus";

const TEL_DO_CONTATO = "+5511911112222";
const TEL_DE_OUTRA_PESSOA = "11988887777";

function ctx(over: Partial<McpContext> & { telefone?: string | null }): McpContext {
  const telefone = over.telefone === undefined ? TEL_DO_CONTATO : over.telefone;
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: telefone ? { phone_number: telefone } : null }) }) }),
      }),
    }),
  };
  return { organizationId: "org-1", supabase, ...over } as unknown as McpContext;
}

/** O telefone que chegou ao Nodus, venha em query ou em body. */
function telefoneEnviado(): unknown {
  const arg = nodusRequest.mock.calls.at(-1)?.[1] as { query?: { telefone?: string }; body?: { telefone?: string } };
  return arg.query?.telefone ?? arg.body?.telefone;
}

const CHAMADAS = [
  ["nodus_consultar_catalogo", nodusConsultarCatalogo, {}],
  ["nodus_status_pedido", nodusStatusPedido, { limite: 3 }],
  [
    "nodus_criar_pedido",
    nodusCriarPedido,
    {
      endereco: "Rua A, 1",
      itens: [{ produtoId: "p1", quantidade: 1 }],
      formaPagamento: "PIX",
      mensagem_id: "m1",
    },
  ],
  ["nodus_solicitar_cancelamento", nodusSolicitarCancelamento, { order_id: "o1", motivo: "mudei de ideia" }],
  ["nodus_validar_codigo_indicacao", nodusValidarCodigoIndicacao, { codigo: "NOD123" }],
  ["nodus_ativar_cliente", nodusAtivarCliente, { nome: "Fulano", endereco: "Rua B, 22 - Centro" }],
] as const;

describe.each(CHAMADAS)("%s", (_nome, tool, extra) => {
  beforeEach(() => nodusRequest.mockClear());
  const run = (c: McpContext) =>
    (tool.handler as (i: unknown, c: McpContext) => Promise<unknown>)({ telefone: TEL_DE_OUTRA_PESSOA, ...extra }, c);

  it("no turno, ignora o telefone do modelo e usa o do contato da conversa", async () => {
    await run(ctx({ contatoDoTurno: "contato-1" }));
    expect(telefoneEnviado()).toBe(TEL_DO_CONTATO);
  });

  it("no turno, contato sem telefone: falha fechado, sem chamar o Nodus", async () => {
    const r = (await run(ctx({ contatoDoTurno: "contato-1", telefone: null }))) as { sucesso: boolean };
    expect(r.sucesso).toBe(false);
    expect(nodusRequest).not.toHaveBeenCalled();
  });

  it("fora do turno (MCP externo / rota HTTP), o telefone informado vale como antes", async () => {
    await run(ctx({}));
    expect(telefoneEnviado()).toBe(TEL_DE_OUTRA_PESSOA);
  });
});
