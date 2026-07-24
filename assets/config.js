// Configuración pública de Supabase. La service role key NUNCA va en este archivo.
// Completa SUPABASE_URL y SUPABASE_ANON_KEY antes de publicar.
window.SOLIDO_CONFIG = {
  SUPABASE_URL: "https://ruumcekveiqmzjxunytj.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_rDtKHoyeR6fuSSFeQoM8ng_BUygxGi6",
  CREATE_USER_FUNCTION: "create-user",
  RESET_PASSWORD_FUNCTION: "reset-user-password",
  // Clave pública VAPID para las notificaciones push. Es pública por diseño
  // (la privada solo vive como secreto en la Edge Function, nunca aquí).
  VAPID_PUBLIC_KEY: "BMkD4s7bYBDJWbLhX_XjH-aXF_A0Kwv_KIXR7Bp9DK_xo4ws5JTu-v0E2Ge_e0415p5g0upTznh_EGA46FFwk_A"
};
