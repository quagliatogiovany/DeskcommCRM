/**
 * Tools da PONTE COM O NODUS — Fase 4 do CRM externo
 * (docs/backlog/crm-externo-deskcomm-plano.md, repo do Nodus).
 *
 * O Nodus (o sistema de delivery em si — pedido, estoque, motoboy) não é
 * reconstruído aqui: cada tool só faz um `fetch` pra
 * `app/api/integrations/deskcomm/*`, que já existe e já está em produção
 * desde a Fase 1. Ver `lib/mcp/tools/nodus-client.ts` pro transporte + auth
 * compartilhados.
 *
 * `criar_pedido` é `critico` (ver `pacotes.ts`): dispara efeito real fora do
 * sistema — reserva estoque e despacha motoboy de verdade (exceto Pix, que o
 * próprio Nodus segura pra confirmação humana). Não entra ligado por pacote;
 * o dono liga essa, uma a uma, sabendo o que está autorizando.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { NodusApiError, nodusRequest, mensagemParaCodigoNodus } from "./nodus-client";

// ---------------------------------------------------------------------------
// nodus_consultar_catalogo
// ---------------------------------------------------------------------------

const consultarCatalogoInputShape = {
  telefone: z
    .string()
    .trim()
    .min(8)
    .describe("Telefone do cliente (com DDI/DDD), o mesmo que identifica o cadastro dele na loja."),
};

interface NodusCatalogoItem {
  produtoId: string;
  nome: string;
  preco: number;
  categoria?: string;
  descricao?: string;
  estoqueDisponivel: number;
}

export const nodusConsultarCatalogo: McpToolDefinition<typeof consultarCatalogoInputShape> = {
  name: "nodus_consultar_catalogo",
  description:
    "Lista os produtos à venda na loja de delivery (Nodus) — nome, preço e estoque disponível. Use " +
    "antes de montar um pedido: os `produtoId` daqui são o que `nodus_criar_pedido` aceita. Exige que " +
    "o cliente já tenha cadastro ativo na loja (indicação + dados); se não tiver, a resposta explica o " +
    "que fazer.",
  inputSchema: consultarCatalogoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    try {
      const body = (await nodusRequest(ctx, {
        method: "GET",
        path: "api/integrations/deskcomm/catalogo",
        query: { telefone: input.telefone },
      })) as { produtos: NodusCatalogoItem[] };
      return { sucesso: true, produtos: body.produtos };
    } catch (err) {
      if (err instanceof NodusApiError) {
        return { sucesso: false, mensagem: mensagemParaCodigoNodus(err.code, err.message) };
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// nodus_status_pedido
// ---------------------------------------------------------------------------

const statusPedidoInputShape = {
  telefone: z.string().trim().min(8).describe("Telefone do cliente, o mesmo usado no cadastro."),
  limite: z.number().int().min(1).max(20).optional().default(5),
};

interface NodusPedidoResumo {
  orderId: string;
  status: string;
  total: number;
  itens: string;
  criadoEm: string;
}

export const nodusStatusPedido: McpToolDefinition<typeof statusPedidoInputShape> = {
  name: "nodus_status_pedido",
  description:
    "Lista os pedidos deste cliente na loja de delivery (Nodus), do mais recente pro mais antigo — status, " +
    "valor e itens. Use antes de dizer 'seu pedido está a caminho' ou repetir informação: confirme o status " +
    "real aqui.",
  inputSchema: statusPedidoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    try {
      const body = (await nodusRequest(ctx, {
        method: "GET",
        path: "api/integrations/deskcomm/pedidos",
        query: { telefone: input.telefone, limite: String(input.limite) },
      })) as { pedidos: NodusPedidoResumo[] };
      return { sucesso: true, pedidos: body.pedidos };
    } catch (err) {
      if (err instanceof NodusApiError) {
        return { sucesso: false, mensagem: mensagemParaCodigoNodus(err.code, err.message) };
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// nodus_criar_pedido
// ---------------------------------------------------------------------------

const FORMAS_PAGAMENTO = ["PIX", "CREDIT_CARD", "DELIVERY_CARD", "DELIVERY_CASH"] as const;

const criarPedidoInputShape = {
  telefone: z.string().trim().min(8).describe("Telefone do cliente, o mesmo usado no cadastro."),
  endereco: z.string().trim().min(3).describe("Endereço completo de entrega."),
  bairro: z.string().trim().optional(),
  nome: z.string().trim().optional(),
  itens: z
    .array(
      z.object({
        produtoId: z.string().min(1).describe("`produtoId` devolvido por nodus_consultar_catalogo."),
        quantidade: z.number().int().min(1),
      }),
    )
    .min(1)
    .describe("Itens do pedido. O preço é o do catálogo da loja — não invente valor aqui."),
  formaPagamento: z
    .enum(FORMAS_PAGAMENTO)
    .describe(
      "PIX (loja confere manualmente antes de despachar — não prometa saída imediata), CREDIT_CARD/" +
        "DELIVERY_CARD/DELIVERY_CASH (despacha na hora).",
    ),
  mensagem_id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Identificador único desta tentativa (id da mensagem/turno da conversa). Repita o MESMO valor se " +
        "reenviar por retry — evita criar o pedido duas vezes.",
    ),
};

interface NodusCriarPedidoResult {
  orderId: string;
  total: number;
  status: string;
  pix?: { qrCodeBase64: string; copyPaste: string };
}

export const nodusCriarPedido: McpToolDefinition<typeof criarPedidoInputShape> = {
  name: "nodus_criar_pedido",
  description:
    "Cria um pedido DE VERDADE na loja de delivery (Nodus) — reserva estoque e, se o pagamento não for " +
    "Pix, despacha motoboy na hora. Confirme itens, endereço e forma de pagamento com o cliente ANTES de " +
    "chamar — não dá pra desfazer um despacho. Pix não despacha sozinho: a loja confere o pagamento antes.",
  inputSchema: criarPedidoInputShape,
  category: "write",
  // `ai_operator`, não `agent`: não há rota HTTP equivalente do Deskcomm cuja
  // paridade justificasse `agent` (tests/unit/capacidade-alcancavel-pelo-agente.test.ts)
  // — fechar pedido de verdade numa loja de terceiro é capacidade nova do
  // agente, não trabalho que um atendente humano já faz pela tela daqui.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const body = (await nodusRequest(ctx, {
        method: "POST",
        path: "api/integrations/deskcomm/pedidos",
        body: {
          telefone: input.telefone,
          endereco: input.endereco,
          bairro: input.bairro,
          nome: input.nome,
          itens: input.itens,
          formaPagamento: input.formaPagamento,
          mensagemId: input.mensagem_id,
        },
      })) as NodusCriarPedidoResult;
      return { sucesso: true, ...body };
    } catch (err) {
      if (err instanceof NodusApiError) {
        return { sucesso: false, mensagem: mensagemParaCodigoNodus(err.code, err.message) };
      }
      throw err;
    }
  },
};
