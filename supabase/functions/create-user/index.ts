import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const normalizeUsername = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Sesión no válida.");
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(url, service);
    const token = authHeader.replace("Bearer ", "");
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) throw new Error("Sesión no válida.");
    const { data: caller } = await adminClient.from("profiles").select("role,active").eq("id", authData.user.id).single();
    if (caller?.role !== "admin" || !caller.active) return new Response(JSON.stringify({ error: "Solo los administradores pueden crear usuarios." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const username = normalizeUsername(body.username || "");
    const email = normalizeEmail(body.email || body.contact_email || "");
    const { password, full_name, job_title_en, active = true } = body;
    const role = body.role === "admin" ? "admin" : "collaborator";
    if (!username || !email || !password || !full_name || !job_title_en) throw new Error("Faltan datos obligatorios (usuario, email real, contraseña, nombre y cargo).");
    if (!isValidEmail(email)) throw new Error("El email no es válido.");
    if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
    const { data: existingUsername } = await adminClient.from("profiles").select("id").ilike("username", username).maybeSingle();
    if (existingUsername) throw new Error("Ese nombre de usuario ya existe.");
    const { data: existingEmail } = await adminClient.from("profiles").select("id").ilike("contact_email", email).maybeSingle();
    if (existingEmail) throw new Error("Ese email ya está en uso por otra cuenta.");

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username, contact_email: email, full_name, job_title_en, role },
    });
    if (createError) throw createError;
    const { error: profileError } = await adminClient.from("profiles").update({ username, contact_email: email, full_name, job_title_en, role, active: Boolean(active), updated_at: new Date().toISOString() }).eq("id", created.user.id);
    if (profileError) throw profileError;
    return new Response(JSON.stringify({ user_id: created.user.id, username }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "No se pudo crear el usuario." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
