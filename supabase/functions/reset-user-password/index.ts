import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  try{
    const authHeader=req.headers.get("Authorization"); if(!authHeader)throw new Error("Sesión no válida.");
    const url=Deno.env.get("SUPABASE_URL")!, anon=Deno.env.get("SUPABASE_ANON_KEY")!, service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient=createClient(url,anon,{global:{headers:{Authorization:authHeader}}});
    const adminClient=createClient(url,service);
    const token=authHeader.replace("Bearer ","");
    const {data:authData,error:authError}=await userClient.auth.getUser(token);
    if(authError||!authData.user)throw new Error("Sesión no válida.");
    const {data:caller}=await adminClient.from("profiles").select("role,active").eq("id",authData.user.id).single();
    if(caller?.role!=="admin"||!caller.active)return new Response(JSON.stringify({error:"Solo los administradores pueden restablecer contraseñas."}),{status:403,headers:{...corsHeaders,"Content-Type":"application/json"}});
    const {user_id,password}=await req.json();
    if(!user_id||!password||password.length<8)throw new Error("La contraseña debe tener al menos 8 caracteres.");
    const {error}=await adminClient.auth.admin.updateUserById(user_id,{password}); if(error)throw error;
    return new Response(JSON.stringify({ok:true}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
  }catch(error){return new Response(JSON.stringify({error:error.message||"No se pudo restablecer la contraseña."}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}})}
});
