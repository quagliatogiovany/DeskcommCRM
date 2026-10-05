/**
 * O que a tela de Recuperação manda pra `PUT /api/v1/recuperacao/config`.
 * As faixas espelham os CHECK da migration 0559 — validação de entrada, não
 * comportamento (a fonte única do comportamento é o banco).
 */
import { z } from "zod";

export const recuperacaoConfigSchema = z
  .object({
    ativo: z.boolean(),
    dias_sem_pedido: z.number().int().min(1).max(3650),
    nao_repetir_antes_dias: z.number().int().min(1).max(3650),
    mensagem: z.string().trim().max(4096),
    channel_session_id: z.string().uuid().nullable(),
    janela_inicio_hora: z.number().int().min(0).max(23),
    janela_fim_hora: z.number().int().min(0).max(23),
    recorrencia: z.enum(["manual", "diaria", "semanal"]),
    dia_semana: z.number().int().min(0).max(6).nullable().optional(),
    hora_disparo: z.number().int().min(0).max(23),
    limite_por_rodada: z.number().int().min(1).max(5000),
    base_legal: z.enum(["consent", "legitimate_interest"]),
    lia_ref: z.string().trim().max(120).nullable().optional(),
  })
  .refine((c) => c.janela_inicio_hora < c.janela_fim_hora, {
    message: "O horário de início precisa ser antes do horário de fim.",
    path: ["janela_fim_hora"],
  })
  .refine((c) => c.recorrencia !== "semanal" || c.dia_semana != null, {
    message: "Escolha o dia da semana para recorrência semanal.",
    path: ["dia_semana"],
  })
  .refine((c) => c.base_legal !== "legitimate_interest" || (c.lia_ref ?? "").trim() !== "", {
    message: "Interesse legítimo exige a referência da avaliação (LIA).",
    path: ["lia_ref"],
  })
  .refine((c) => !c.ativo || (c.channel_session_id ?? "").trim() !== "", {
    message: "Escolha a conexão de WhatsApp antes de ativar.",
    path: ["channel_session_id"],
  })
  .refine((c) => !c.ativo || c.mensagem.trim() !== "", {
    message: "Escreva a mensagem antes de ativar.",
    path: ["mensagem"],
  });

export type RecuperacaoConfigEntrada = z.infer<typeof recuperacaoConfigSchema>;
