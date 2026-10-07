import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodusRequest, sendMessageHandler, NodusApiErrorFalso } = vi.hoisted(() => ({
  nodusRequest: vi.fn(),
  sendMessageHandler: vi.fn(async (..._a: unknown[]) => ({})),
  NodusApiErrorFalso: class NodusApiErrorFalso extends Error {
    constructor(
      message: string,
      public code: string | null,
      public status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/mcp/tools/nodus-client", () => ({
  nodusRequest: (...a: unknown[]) => nodusRequest(...a),
  NodusApiError: NodusApiErrorFalso,
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { confirmarPixDoDono, extrairOkDoDono } from "./pix-do-dono";

const ENTRADA = {
  organizationId: "org-1",
  contactId: "c-1",
  conversationId: "conv-1",
  messageId: "m-1",
  channelSessionId: "s-1",
  nomeDoContato: null,
  requestId: "req-1",
};

function admin(telefone: string | null = "5548999990000") {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: telefone ? { phone_number: telefone } : null }) }) }),
      }),
    }),
  } as never;
}

const chamar = (texto: string | null, tel: string | null = "5548999990000") =>
  confirmarPixDoDono(admin(tel), { ...ENTRADA, texto } as never);

beforeEach(() => {
  nodusRequest.mockReset();
  sendMessageHandler.mockClear();
});

describe("extrairOkDoDono", () => {
  it.each([
    ["OK 7F3K", "7F3K"],
    ["ok 7f3k", "7f3k"],
    ["Ok, 7F3K!", "7F3K"],
    ["ok: Maria", "Maria"],
    ["  OK   Maria Silva  ", "Maria Silva"],
    ["ok", ""],
    ["OK.", ""],
    ["ok!", ""],
    ["OK\n7F3K", "7F3K"],
  ])("%j → %j", (texto, esperado) => {
    expect(extrairOkDoDono(texto)).toBe(esperado);
  });

  it.each([
    "okay vamos lá",
    "tudo ok por aqui, obrigado",
    "quero fazer um pedido, ok?",
    "oi",
    "",
    "ok " + "x".repeat(80),
  ])("%j não é um OK do dono", (texto) => {
    expect(extrairOkDoDono(texto)).toBeNull();
  });

  it("sem texto", () => {
    expect(extrairOkDoDono(null)).toBeNull();
    expect(extrairOkDoDono(undefined)).toBeNull();
  });
});

describe("confirmarPixDoDono", () => {
  it("mensagem que não é um 'ok' nem chega ao Nodus", async () => {
    expect(await chamar("quero um pedido")).toBe(false);
    expect(nodusRequest).not.toHaveBeenCalled();
  });

  it("Pix liberado: manda ao Nodus o número de quem escreveu + o texto depois do OK, e responde ao dono", async () => {
    nodusRequest.mockResolvedValue({ orderId: "o1", codigo: "7F3K", cliente: "Maria", total: 80, despachado: true });
    expect(await chamar("OK 7F3K")).toBe(true);

    const [, opcoes] = nodusRequest.mock.calls[0] as [unknown, { method: string; path: string; body: unknown }];
    expect(opcoes.method).toBe("POST");
    expect(opcoes.path).toBe("api/integrations/deskcomm/pedidos/confirmar-pix");
    expect(opcoes.body).toEqual({ telefoneDoDono: "5548999990000", texto: "7F3K" });

    const corpo = (sendMessageHandler.mock.calls[0] as unknown[])[2] as { body: string; conversation_id: string };
    expect(corpo.conversation_id).toBe("conv-1");
    expect(corpo.body).toContain("Pix confirmado");
    expect(corpo.body).toContain("7F3K");
    expect(corpo.body).toContain("Maria");
    expect(corpo.body).toContain("liberado para o motoboy");
  });

  it("Pix aceito mas sem motoboy livre: diz isso, em vez de prometer motoboy", async () => {
    nodusRequest.mockResolvedValue({ orderId: "o1", codigo: "7F3K", cliente: "Maria", total: 80, despachado: false });
    await chamar("ok");
    const corpo = (sendMessageHandler.mock.calls[0] as unknown[])[2] as { body: string };
    expect(corpo.body).toContain("não há motoboy livre");
    expect(corpo.body).not.toContain("liberado para o motoboy");
  });

  it("'ok' puro vai com texto vazio", async () => {
    nodusRequest.mockResolvedValue({ orderId: "o1", codigo: "A1B2", cliente: "Ana", total: 10, despachado: true });
    await chamar("OK");
    expect((nodusRequest.mock.calls[0] as unknown[])[1]).toMatchObject({ body: { texto: "" } });
  });

  it("mais de um Pix: repassa a lista do Nodus ao dono e trata a mensagem (agente não é acordado)", async () => {
    nodusRequest.mockRejectedValue(new NodusApiErrorFalso("Há mais de um Pix aguardando: 7F3K Maria, 9XZ2 Maria.", "AMBIGUO", 409));
    expect(await chamar("ok maria")).toBe(true);
    const corpo = (sendMessageHandler.mock.calls[0] as unknown[])[2] as { body: string };
    expect(corpo.body).toContain("7F3K");
    expect(corpo.body).toContain("9XZ2");
  });

  it("Pix pendente mas nome não bate: responde ao dono", async () => {
    nodusRequest.mockRejectedValue(new NodusApiErrorFalso('Não achei Pix aguardando para "joao".', "PEDIDO_NAO_ENCONTRADO", 404));
    expect(await chamar("ok joao")).toBe(true);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it.each([
    ["não é o dono (403)", new NodusApiErrorFalso("Este número não é o do dono", "NAO_AUTORIZADO", 403)],
    ["nada pendente na loja", new NodusApiErrorFalso("Não há Pix aguardando confirmação.", "SEM_PIX_PENDENTE", 404)],
    ["loja sem cadastro ativo", new NodusApiErrorFalso("Token inválido", null, 401)],
    ["erro do Nodus", new NodusApiErrorFalso("Erro interno", null, 500)],
  ])("%s: segue o caminho normal, sem responder e sem tratar a mensagem", async (_n, erro) => {
    nodusRequest.mockRejectedValue(erro);
    expect(await chamar("ok 7F3K")).toBe(false);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("Nodus fora do ar (falha de rede): não derruba a cadeia, segue o caminho normal", async () => {
    nodusRequest.mockRejectedValue(new Error("fetch failed"));
    expect(await chamar("ok 7F3K")).toBe(false);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("contato sem telefone (conversa por LID): nem pergunta ao Nodus", async () => {
    expect(await chamar("ok 7F3K", null)).toBe(false);
    expect(nodusRequest).not.toHaveBeenCalled();
  });
});
