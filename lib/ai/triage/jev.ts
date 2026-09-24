/**
 * Triagem de intenção via TypeSafe/Jev (System One) — classificador rápido e
 * barato (0.07–0.5s, sem custo de output) chamado ANTES de acordar o agente
 * (LLM completo). Usado por `lib/channels/pos-entrada.ts` pra resolver direto
 * perguntas simples (status do pedido, tem estoque de X) sem gastar um turno
 * inteiro do agent-engine.
 *
 * `null` em qualquer erro/timeout: quem chama deve seguir o fluxo padrão
 * (fail-open — o despacho do agente nunca pode ficar refém deste classificador).
 */
import { logger } from "@/lib/logger";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export type JevIntent = "status_pedido" | "consulta_estoque" | "pedido_novo" | "venda_complexa" | "spam";

export interface JevTriage {
  intent: JevIntent;
  intentConfidence: number;
  complexityScore: number;
}

interface JevResponse {
  answers: {
    intent: { choice: JevIntent; confidence: number };
    complexity: { score: number };
  };
}

export async function triageMessage(text: string): Promise<JevTriage | null> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: text,
        model: "jev-latest",
        questions: {
          intent: {
            type: "choice",
            instructions: "A intenção principal do cliente nesta mensagem de WhatsApp de uma loja de delivery",
            criteria: {
              status_pedido: "Perguntando sobre um pedido já feito",
              consulta_estoque: "Perguntando se tem um produto disponível, antes de comprar",
              pedido_novo: "Está fazendo ou tentando fazer um pedido novo",
              venda_complexa: "Dúvida que exige julgamento: combo, troca, negociação, reclamação",
              spam: "Mensagem irrelevante, áudio, figurinha, propaganda",
            },
          },
          complexity: {
            type: "score",
            instructions: "Quão complexo é resolver esta mensagem",
            criteria: ["Resolve com consulta direta", "Exige algum julgamento", "Caso raro, precisa escalar"],
          },
        },
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) throw new Error(`JEV HTTP ${res.status}`);

    const data = (await res.json()) as JevResponse;
    return {
      intent: data.answers.intent.choice,
      intentConfidence: data.answers.intent.confidence,
      complexityScore: data.answers.complexity.score,
    };
  } catch (err) {
    // Nunca logar `text`: é corpo de mensagem do cliente (ver cabeçalho de lib/logger.ts).
    logger.warn("jev.triage: falhou, turno segue pro agente normal", {
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}
