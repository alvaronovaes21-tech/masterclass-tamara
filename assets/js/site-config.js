/*
 * Configuração PÚBLICA do site (pode ficar no código; vai para o navegador).
 *
 *  supabaseUrl      -> "Project URL" do seu projeto Supabase (Settings > API). Ex.: https://abcdxyz.supabase.co
 *  supabaseAnonKey  -> chave PÚBLICA "anon" / "publishable" (Settings > API).
 *                      NUNCA coloque aqui a chave "service_role" / "secret".
 *  turnstileSiteKey -> (opcional) chave PÚBLICA do Cloudflare Turnstile, se quiser CAPTCHA no formulário.
 *
 * Enquanto supabaseUrl estiver vazio, o site funciona normalmente, a seção de depoimentos
 * mostra apenas o convite discreto e o formulário avisa que o envio ainda não está disponível.
 * Passo a passo completo: docs/DEPOIMENTOS.md
 */
window.SITE_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  turnstileSiteKey: ''
};
