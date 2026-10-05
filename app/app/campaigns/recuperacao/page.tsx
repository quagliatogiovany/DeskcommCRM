/**
 * Campanhas → Recuperação. Configura o disparo de recuperação de clientes
 * inativos desta organização (migration 0559) — a tela só aparece pra quem já
 * ligou a loja no Nodus (`organizations.nodus_api_key`): sem isso não há de
 * onde vir "quem está inativo".
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

import { RecuperacaoDeClientes } from "./_client";

export const metadata = { title: "Recuperação de clientes" };
export const dynamic = "force-dynamic";

export default async function RecuperacaoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("nodus_api_key")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  if (!data?.nodus_api_key) redirect("/app/campaigns");

  return <RecuperacaoDeClientes />;
}
