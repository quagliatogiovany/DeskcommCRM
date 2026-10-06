// @vitest-environment jsdom
import { createRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { EditorDeVariantes, type EditorDeVariantesHandle } from "./EditorDeVariantes";

afterEach(cleanup);

/** O pai de verdade: guarda UM texto e passa o `ref` que os botões de variável usam. */
function Tela({ inicial = "", saida }: { inicial?: string; saida: { texto: string } }) {
  const [texto, setTexto] = useState(inicial);
  saida.texto = texto;
  const ref = createRef<EditorDeVariantesHandle>();
  return (
    <>
      <EditorDeVariantes ref={ref} value={texto} onChange={setTexto} ariaLabel="Texto da mensagem" />
      <button type="button" onClick={() => ref.current?.inserir("{{primeiro_nome}}")}>
        inserir
      </button>
    </>
  );
}

describe("EditorDeVariantes", () => {
  it("começa com uma caixa só, sem 'Versão 1' nem 'Remover'", () => {
    render(<Tela saida={{ texto: "" }} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText("Remover")).toBeNull();
  });

  it("'Adicionar outra versão' abre uma segunda caixa e o texto guardado ganha o separador", async () => {
    const saida = { texto: "" };
    render(<Tela inicial="Oi!" saida={saida} />);
    await userEvent.click(screen.getByText("Adicionar outra versão"));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByText("Versão 1")).toBeTruthy();
    expect(screen.getByText("Versão 2")).toBeTruthy();
    await userEvent.type(screen.getAllByRole("textbox")[1]!, "Olá!");
    expect(saida.texto).toBe("Oi!\n---\nOlá!");
  });

  it("remover uma versão volta ao texto simples", async () => {
    const saida = { texto: "" };
    render(<Tela inicial={"A\n---\nB"} saida={saida} />);
    await userEvent.click(screen.getAllByText("Remover")[0]!);
    expect(saida.texto).toBe("B");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("texto antigo com separador solto abre já dividido", () => {
    render(<Tela inicial={"A\n-----\nB\n***\nC"} saida={{ texto: "" }} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
  });

  it("o botão de variável escreve na versão e na posição do cursor, não no fim", async () => {
    const saida = { texto: "" };
    render(<Tela inicial={"Oi , tudo bem?\n---\nOlá!"} saida={saida} />);
    const primeira = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    primeira.focus();
    primeira.setSelectionRange(3, 3);
    fireEvent.select(primeira);
    await userEvent.click(screen.getByText("inserir"));
    expect(saida.texto).toBe("Oi {{primeiro_nome}}, tudo bem?\n---\nOlá!");
  });

  it("na segunda versão, escreve na segunda", async () => {
    const saida = { texto: "" };
    render(<Tela inicial={"A\n---\nOlá !"} saida={saida} />);
    const segunda = screen.getAllByRole("textbox")[1] as HTMLTextAreaElement;
    segunda.focus();
    segunda.setSelectionRange(4, 4);
    fireEvent.select(segunda);
    await userEvent.click(screen.getByText("inserir"));
    expect(saida.texto).toBe("A\n---\nOlá {{primeiro_nome}}!");
  });

  it("sem cursor guardado, escreve no fim da primeira versão (caixa única continua como antes)", async () => {
    const saida = { texto: "" };
    render(<Tela inicial="Oi " saida={saida} />);
    await userEvent.click(screen.getByText("inserir"));
    expect(saida.texto).toBe("Oi {{primeiro_nome}}");
  });
});
