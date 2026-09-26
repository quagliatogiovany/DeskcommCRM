/**
 * Capacidades da PONTE COM O NODUS — o sistema de delivery por trás da loja
 * (pedido, estoque, motoboy). Ver `lib/mcp/tools/nodus.ts` pros handlers.
 */
import { declararTools } from "./tipos";

export const TOOLS_NODUS = declararTools([
  {
    name: "nodus_consultar_catalogo",
    category: "read",
    rotulo: "Ver o catálogo da loja de delivery",
    explicacao:
      "Mostra os produtos à venda, o preço e o estoque disponível na loja de delivery (Nodus), para o assistente responder com o que existe de verdade.",
    oQueToca: "Catálogo da loja de delivery",
    risco: "seguro",
    // Só "atender", de propósito: "vender" é o pacote padrão do onboarding
    // (`PACOTE_PADRAO_DO_ONBOARDING`) — qualquer automática nova ali cresce o
    // piso de TODO agente novo e aperta a vaga de todos os outros pacotes
    // contra `TETO_TOOLS_POR_AGENTE` (ver tests/unit/pacote-reserva-vaga-da-critica.test.ts).
    pacotes: ["atender"],
  },
  {
    name: "nodus_status_pedido",
    category: "read",
    rotulo: "Ver os pedidos do cliente na loja de delivery",
    explicacao:
      "Mostra os pedidos que este cliente já fez na loja de delivery (Nodus) e o status de cada um, para o assistente não repetir informação nem inventar prazo.",
    oQueToca: "Pedidos da loja de delivery",
    risco: "seguro",
    pacotes: ["atender"], // mesmo motivo acima.
  },
  {
    name: "nodus_criar_pedido",
    category: "write",
    rotulo: "Fechar um pedido na loja de delivery",
    explicacao:
      "Cria um pedido de verdade na loja de delivery (Nodus): reserva o estoque e, fora do Pix, já chama o motoboy. Não dá para desfazer um pedido despachado.",
    oQueToca: "Pedidos da loja de delivery",
    risco: "critico",
    pacotes: ["vender"],
  },
  {
    name: "nodus_solicitar_cancelamento",
    category: "write",
    rotulo: "Avisar a loja que o cliente quer cancelar um pedido",
    explicacao:
      "Não cancela nada: avisa o dono da loja (sino e WhatsApp) que o cliente pediu cancelamento, para uma pessoa decidir.",
    oQueToca: "Pedidos da loja de delivery",
    risco: "atencao",
    pacotes: ["atender"],
  },
]);
