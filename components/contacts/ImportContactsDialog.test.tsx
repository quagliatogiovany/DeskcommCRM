// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const mutateAsync = vi.fn();
vi.mock("@/hooks/contacts/useImportContacts", () => ({
  useImportContacts: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { ImportContactsDialog } from "./ImportContactsDialog";

/** jsdom não implementa `Blob.arrayBuffer`; o navegador sim. */
function arquivo(texto: string, nome = "contatos.csv"): File {
  const f = new File([texto], nome, { type: "text/csv" });
  Object.defineProperty(f, "arrayBuffer", { value: async () => new TextEncoder().encode(texto).buffer });
  return f;
}

const csvComPessoas = (n: number) =>
  ["nome,telefone", ...Array.from({ length: n }, (_, i) => `Pessoa ${i + 1},4899${String(i).padStart(7, "0")}`)].join("\n");

async function escolher(f: File) {
  const input = screen.getByLabelText("Arquivo CSV") as HTMLInputElement;
  await userEvent.upload(input, f);
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ total_linhas: 1, imported: 1, skipped_duplicates: 0, errors: [] });
});
afterEach(cleanup);

describe("ImportContactsDialog", () => {
  it("tem o botão de planilha de exemplo, que baixa um CSV", async () => {
    const criar = vi.fn(() => "blob:exemplo");
    const revogar = vi.fn();
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: revogar });
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Baixar planilha de exemplo"));

    expect(criar).toHaveBeenCalledOnce();
    const blob = (criar.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toContain("text/csv");
    expect(clique).toHaveBeenCalledOnce();
    clique.mockRestore();
  });

  it("mostra quantas pessoas e em quantas partes, ANTES de importar", async () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    await escolher(arquivo(csvComPessoas(1200)));
    expect(await screen.findByText(/1200 pessoa\(s\) encontrada\(s\)/)).toBeTruthy();
    expect(screen.getByText(/será enviado em 3 partes/)).toBeTruthy();
  });

  it("arquivo pequeno não fala em partes", async () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    await escolher(arquivo(csvComPessoas(40)));
    expect(await screen.findByText(/40 pessoa\(s\) encontrada\(s\)/)).toBeTruthy();
    expect(screen.queryByText(/será enviado em/)).toBeNull();
  });

  it("passou de 5.000: avisa e trava o botão Importar", async () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    await escolher(arquivo(csvComPessoas(5001)));
    expect(await screen.findByText(/Máximo de 5\.000 contatos por importação/)).toBeTruthy();
    expect((screen.getByText("Importar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("manda o arquivo e a etiqueta digitada para a importação", async () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    const f = arquivo(csvComPessoas(3));
    await escolher(f);
    await screen.findByText(/3 pessoa\(s\) encontrada\(s\)/);
    await userEvent.type(screen.getByLabelText("Etiqueta para esta lista (opcional)"), "recuperacao-2026");
    await userEvent.click(screen.getByText("Importar"));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledOnce());
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ file: f, etiqueta: "recuperacao-2026" }));
    expect(await screen.findByText(/1 importado\(s\)/)).toBeTruthy();
  });

  it("importação interrompida no meio diz de onde retomar e que o resto já entrou", async () => {
    mutateAsync.mockResolvedValue({
      total_linhas: 500, imported: 500, skipped_duplicates: 0, errors: [],
      interrompido: { aPartirDaLinha: 502, motivo: "falha de conexão" },
    });
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    await escolher(arquivo(csvComPessoas(1200)));
    await screen.findByText(/1200 pessoa/);
    await userEvent.click(screen.getByText("Importar"));
    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("linha 502");
    expect(aviso.textContent).toContain("já foi importado");
  });
});
