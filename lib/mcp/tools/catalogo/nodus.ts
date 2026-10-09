/**
 * Capacidades da PONTE COM O NODUS — o sistema de delivery por trás da loja
 * (pedido, estoque, motoboy). Ver `lib/mcp/tools/nodus.ts` pros handlers.
 *
 * ⚠️ FORK, NÃO UPSTREAM. As ferramentas `nodus_*` (6 delas no pacote "atender") são do fork
 * `quagliatogiovany/DeskcommCRM` e ficam no Atender de propósito: quem liga
 * o Atender precisa consultar pedido/estoque da loja. Elas contam no teto
 * (`TETO_TOOLS_POR_AGENTE`) e por isso o seed do e2e
 * (`tests/e2e/capacidades-do-agente.spec.ts`) tem 5 entradas, não as 11 do upstream — o guarda
 * `teto-do-atender-bate-com-a-recusa-da-spec` mede a conta. Ao mergear o upstream, confira
 * esse arquivo e o guarda. Se o Atender voltar a estourar, o caminho é um pacote próprio
 * "Loja (Nodus)", não subir o teto.
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
  {
    name: "nodus_consultar_promocoes",
    category: "read",
    rotulo: "Ver as promoções ativas da loja de delivery",
    explicacao:
      "Mostra as promoções ativas hoje na loja de delivery (Nodus), para o assistente avisar o cliente e mandar o link do catálogo, onde o desconto aparece no checkout.",
    oQueToca: "Clientes e promoções da loja de delivery",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "nodus_validar_codigo_indicacao",
    category: "write",
    rotulo: "Conferir o código de indicação de um cliente novo",
    explicacao:
      "Confere se o código de indicação que o cliente novo enviou é válido na loja de delivery (Nodus). Com 2 erros o assistente para de responder e o dono é avisado.",
    oQueToca: "Clientes e promoções da loja de delivery",
    risco: "atencao",
    pacotes: ["atender"],
  },
  {
    name: "nodus_ativar_cliente",
    category: "write",
    rotulo: "Cadastrar o cliente novo na loja de delivery",
    explicacao:
      "Conclui o cadastro (nome e endereço) de um cliente que já validou o código de indicação, e devolve o código de indicação dele.",
    oQueToca: "Clientes e promoções da loja de delivery",
    risco: "atencao",
    pacotes: ["atender"],
  },
  {
    name: "nodus_sugerir_complemento",
    category: "read",
    rotulo: "Sugerir um item a mais no pedido (upsell)",
    explicacao:
      "Pede à loja de delivery (Nodus) um produto para oferecer junto do que o cliente já escolheu, por regra fixa (o que mais sai junto, margem, estoque). A oferta fica registrada para medir a taxa de aceite.",
    oQueToca: "Catálogo da loja de delivery",
    risco: "seguro",
    // "reter", não "atender": o Atender já estoura o teto (ver cabeçalho) e o "vender" é o default do onboarding.
    pacotes: ["reter"],
  },
  {
    name: "nodus_meta_semana",
    category: "read",
    rotulo: "Ver a meta de vendas da semana",
    explicacao:
      "Mostra pedidos e faturamento da semana contra a meta que o dono definiu na loja de delivery (Nodus). Só para o assistente saber o ritmo; ele não comenta isso com o cliente.",
    oQueToca: "Pedidos da loja de delivery",
    risco: "seguro",
    pacotes: ["reter"], // idem nodus_sugerir_complemento
  },
]);
