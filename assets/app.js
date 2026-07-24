(() => {
  "use strict";

  const CONFIG = window.SOLIDO_CONFIG || {};
  const isSupabaseConfigured = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
  let supabaseClient = null;

  async function loadSupabaseLibrary() {
    if (!isSupabaseConfigured) throw new Error("La base de datos todavía no está conectada.");
    if (!window.supabase) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/@supabase/supabase-js@2";
        script.onload = resolve;
        script.onerror = () => reject(new Error("No se pudo cargar Supabase. Revisa la conexión a internet."));
        document.head.appendChild(script);
      });
    }
    supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") showRecoverScreen();
    });
  }

  const PROJECT_STATUSES = [
    ["not_started", "Pendiente de iniciar"],
    ["started", "Iniciado"],
    ["in_progress", "En progreso"],
    ["awaiting_client", "Esperando información del cliente"],
    ["awaiting_approval", "Esperando aprobación"],
    ["pending_payment", "Pendiente de pago"],
    ["pending_closure", "Pendiente de cierre"],
    ["completed", "Completado"],
    ["cancelled", "Cancelado"]
  ];
  const CURRENCIES = ["USD", "ARS"];
  const PAYMENT_METHODS = ["Transferencia bancaria", "Efectivo", "PayPal", "Zelle", "Wise", "Otro"];

  const state = {
    user: null,
    profile: null,
    companies: [],
    projects: [],
    extras: [],
    payments: [],
    users: [],
    activities: [],
    currentView: "dashboard",
    modal: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  const today = () => new Date().toISOString().slice(0,10);
  const initials = name => String(name || "U").split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join("").toUpperCase();
  const formatDate = value => value ? new Intl.DateTimeFormat("es-AR", {day:"2-digit",month:"short",year:"numeric"}).format(new Date(`${value}T12:00:00`)) : "Sin fecha";
  const statusLabel = value => PROJECT_STATUSES.find(([key]) => key === value)?.[1] || value || "Sin estado";
  const statusClass = value => ({completed:"completed",cancelled:"cancelled",pending_payment:"pending",pending_closure:"waiting",awaiting_client:"waiting",awaiting_approval:"waiting",not_started:"pending",paid:"paid",partial:"partial",pending:"pending",active:"active"}[value] || "");
  // Cotización del dólar blue (mercado real/paralelo en Argentina, el tipo de cambio que
  // se acerca más a lo que de verdad se recibe con remesas como Remitly, muy distinto del
  // dólar oficial). Se actualiza sola cada pocos minutos mientras la app está abierta.
  let fxRate = null;
  async function refreshFxRate() {
    try {
      const res = await fetch("https://dolarapi.com/v1/dolares/blue");
      const data = await res.json();
      const value = Number(data?.venta);
      if (value > 0) fxRate = value;
    } catch (e) { console.warn("No se pudo actualizar la cotización del dólar.", e); }
  }
  const formatMoney = (amount, currency = "USD") => {
    const base = new Intl.NumberFormat(currency === "ARS" ? "es-AR" : "en-US", {style:"currency",currency,maximumFractionDigits: currency === "ARS" ? 0 : 2}).format(Number(amount || 0));
    if (currency === "USD" && fxRate) {
      const ars = new Intl.NumberFormat("es-AR", {style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Number(amount || 0) * fxRate);
      return `${base} <span class="fx-equiv">≈ ${ars}</span>`;
    }
    return base;
  };
  const isAdmin = () => state.profile?.role === "admin";
  const normalizeUsername = value => String(value || "").trim().toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
  const isRecoveryLink = () => /type=recovery/.test(window.location.hash) || /type=recovery/.test(window.location.search);

  function toast(message, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type === "error" ? "error" : ""}`;
    el.textContent = message;
    $("#toastStack").appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  const supabaseDb = {
    async login(username,password){
      const cleanUsername = normalizeUsername(username);
      if (!cleanUsername) throw new Error("Escribe un usuario válido.");
      const {data:email,error:rpcError} = await supabaseClient.rpc("email_for_username",{p_username:cleanUsername});
      if (rpcError || !email) throw new Error("Usuario o contraseña incorrectos.");
      const {data,error} = await supabaseClient.auth.signInWithPassword({email,password});
      if (error) throw new Error("Usuario o contraseña incorrectos.");
      const profile = await this.getProfile(data.user.id);
      if (!profile?.active) {
        await supabaseClient.auth.signOut();
        throw new Error("Tu cuenta está inactiva. Comunícate con uno de los administradores.");
      }
      return {user:data.user,profile};
    },
    async requestPasswordReset(username){
      const cleanUsername = normalizeUsername(username);
      if (!cleanUsername) return;
      try {
        const {data:email} = await supabaseClient.rpc("email_for_username",{p_username:cleanUsername});
        if (email) {
          const redirectTo = window.location.origin + window.location.pathname;
          await supabaseClient.auth.resetPasswordForEmail(email,{redirectTo});
        }
      } catch (error) { console.warn("No se pudo iniciar la recuperación",error); }
    },
    async session(){
      const {data:{session}} = await supabaseClient.auth.getSession();
      if (!session?.user) return null;
      const profile = await this.getProfile(session.user.id);
      if (!profile?.active) return null;
      return {user:session.user,profile};
    },
    async getProfile(id){
      const {data,error} = await supabaseClient.from("profiles").select("*").eq("id",id).single();
      if (error) throw error;
      return data;
    },
    async logout(){ await supabaseClient.auth.signOut(); },
    async resetUserPassword(user_id,password){
      const {data,error} = await supabaseClient.functions.invoke(CONFIG.RESET_PASSWORD_FUNCTION || "reset-user-password",{body:{user_id,password}});
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
    },
    async changePassword(password){
      const {error} = await supabaseClient.auth.updateUser({password});
      if (error) throw error;
    },
    async load(){
      const tables = ["companies","projects","project_extras","payments","activities"];
      const results = await Promise.all(tables.map(async table => {
        const {data,error} = await supabaseClient.from(table).select("*").order("created_at",{ascending:false});
        if (error) throw error;
        return data || [];
      }));
      let users = [];
      if (isAdmin()) {
        const {data,error} = await supabaseClient.from("profiles").select("*").order("created_at",{ascending:true});
        if (error) throw error;
        users = data || [];
      } else users = [state.profile];
      return {companies:results[0],projects:results[1],extras:results[2],payments:results[3],activities:results[4],users};
    },
    async upsert(table,record,recordId=null){
      const realTable = table === "extras" ? "project_extras" : table;
      const query = recordId
        ? supabaseClient.from(realTable).update({...record,updated_at:new Date().toISOString()}).eq("id",recordId).select("id").single()
        : supabaseClient.from(realTable).insert(record).select("id").single();
      const {data,error} = await query;
      if (error) throw error;
      return data?.id;
    },
    async remove(table,id){
      const realTable = table === "extras" ? "project_extras" : table;
      const {error} = await supabaseClient.from(realTable).delete().eq("id",id);
      if (error) throw error;
    },
    async createUser(payload){
      const {data,error} = await supabaseClient.functions.invoke(CONFIG.CREATE_USER_FUNCTION || "create-user",{body:payload});
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
    },
    async uploadReceipt(paymentId,file){
      const path = `${paymentId}/${Date.now()}-${file.name}`.replace(/\s+/g,"_");
      const {error} = await supabaseClient.storage.from("attachments").upload(path,file,{upsert:true});
      if (error) throw error;
      const {error:updateError} = await supabaseClient.from("payments").update({receipt_path:path,receipt_name:file.name,updated_at:new Date().toISOString()}).eq("id",paymentId);
      if (updateError) throw updateError;
      return path;
    },
    async getReceiptUrl(path){
      const {data,error} = await supabaseClient.storage.from("attachments").createSignedUrl(path,3600);
      if (error) throw error;
      return data.signedUrl;
    },
    async loadTasks(projectId){
      const {data,error} = await supabaseClient.from("tasks").select("*").eq("project_id",projectId).order("created_at",{ascending:true});
      if (error) throw error;
      return data || [];
    },
    async createTask(projectId,title,assignedTo){
      const {error} = await supabaseClient.from("tasks").insert({project_id:projectId,title,created_by:state.profile.id,assigned_to:assignedTo||state.profile.id});
      if (error) throw error;
    },
    async toggleTask(id,done){
      const {error} = await supabaseClient.from("tasks").update({done,updated_at:new Date().toISOString()}).eq("id",id);
      if (error) throw error;
    },
    async deleteTask(id){
      const {error} = await supabaseClient.from("tasks").delete().eq("id",id);
      if (error) throw error;
    }
  };

  const db = supabaseDb;

  async function logActivity(action) {
    try {
      await db.upsert("activities",{actor_id:state.profile.id,action,created_by:state.profile.id});
    } catch (error) {
      console.warn("No se pudo registrar actividad",error);
    }
  }

  async function initialize() {
    $("#modeBadge").textContent = isSupabaseConfigured ? "Base de datos privada" : "Pendiente de conexión";
    bindEvents();
    refreshFxRate().then(() => { if (state.profile) renderCurrentView(); });
    setInterval(() => refreshFxRate().then(() => { if (state.profile) renderCurrentView(); }), 5 * 60 * 1000);
    if (!isSupabaseConfigured) {
      const notice = $("#setupNotice");
      notice.classList.remove("hidden");
      notice.innerHTML = "<strong>Sistema pendiente de conexión segura.</strong><br>Un administrador debe configurar Supabase antes del primer ingreso.";
      $("#loginForm button[type=submit]").disabled = true;
      showAuth("login");
      return;
    }
    try {
      await loadSupabaseLibrary();
      if (isRecoveryLink()) { showAuth("recover"); return; }
      const session = await db.session();
      if (session) await enterApp(session);
      else showAuth("login");
    } catch (error) {
      console.error(error);
      const notice = $("#setupNotice");
      notice.classList.remove("hidden");
      notice.textContent = error.message || "No se pudo conectar con la base de datos.";
      showAuth("login");
    }
  }

  function bindEvents() {
    $$("[data-toggle-password]").forEach(btn => btn.addEventListener("click",() => {
      const input = document.getElementById(btn.dataset.togglePassword);
      input.type = input.type === "password" ? "text" : "password";
    }));
    $("#loginForm").addEventListener("submit",handleLogin);
    $("#forgotForm").addEventListener("submit",handleForgotPassword);
    $("#recoverForm").addEventListener("submit",handleRecoverPassword);
    $("#showForgotBtn").addEventListener("click",() => showAuth("forgot"));
    $("#backToLoginBtn").addEventListener("click",() => showAuth("login"));
    $("#logoutBtn").addEventListener("click",handleLogout);
    $("#sidebarToggle").addEventListener("click",() => $("#sidebar").classList.toggle("open"));
    $$(".nav-item").forEach(btn => btn.addEventListener("click",() => showView(btn.dataset.view)));
    document.addEventListener("click",event => {
      const go = event.target.closest("[data-go-view]"); if (go) showView(go.dataset.goView);
      const open = event.target.closest("[data-open-modal]"); if (open) openModal(open.dataset.openModal);
      const action = event.target.closest("[data-action]"); if (action) handleAction(action);
    });
    $("#quickAddBtn").addEventListener("click",() => openModal("project"));
    $("#closeModalBtn").addEventListener("click",closeModal);
    $("#modalBackdrop").addEventListener("click",event => { if (event.target.id === "modalBackdrop") closeModal(); });
    $("#changePasswordForm").addEventListener("submit",handleChangePassword);
    $("#exportBackupBtn").addEventListener("click",exportBackup);
    $("#exportBackupBtn2").addEventListener("click",exportBackup);
    [
      "companySearch",
      "projectSearch","projectCompanyFilter","projectStatusFilter","projectAssigneeFilter","projectWorkTypeFilter","projectCurrencyFilter","projectDateFrom","projectDateTo",
      "extraSearch","extraStatusFilter","extraCurrencyFilter",
      "paymentSearch","paymentStatusFilter","paymentUserFilter","paymentCurrencyFilter","paymentDateFrom","paymentDateTo"
    ].forEach(id => {
      const el = document.getElementById(id); if (el) el.addEventListener("input",renderCurrentView);
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const button = event.submitter; button.disabled = true; button.textContent = "Ingresando…";
    try {
      const session = await db.login($("#loginUsername").value.trim(),$("#loginPassword").value);
      await enterApp(session);
    } catch (error) { toast(error.message || "No se pudo ingresar.","error"); }
    finally { button.disabled = false; button.textContent = "Ingresar"; }
  }

  async function handleForgotPassword(event) {
    event.preventDefault();
    const button = event.submitter; button.disabled = true; button.textContent = "Enviando…";
    try {
      await db.requestPasswordReset($("#forgotUsername").value.trim());
      toast("Si el usuario existe, enviamos instrucciones al correo registrado.");
      event.target.reset();
      showAuth("login");
    } catch (error) { toast("No se pudo procesar la solicitud.","error"); }
    finally { button.disabled = false; button.textContent = "Enviar enlace de recuperación"; }
  }

  async function handleRecoverPassword(event) {
    event.preventDefault();
    const p = $("#recoverPassword").value, c = $("#recoverPasswordConfirm").value;
    if (p !== c) { toast("Las contraseñas no coinciden.","error"); return; }
    const button = event.submitter; button.disabled = true; button.textContent = "Guardando…";
    try {
      await db.changePassword(p);
      toast("Contraseña actualizada. Ya puedes usar el sistema.");
      history.replaceState(null,"",window.location.pathname);
      const session = await db.session();
      if (session) await enterApp(session); else showAuth("login");
    } catch (error) { toast(error.message || "No se pudo actualizar la contraseña.","error"); }
    finally { button.disabled = false; button.textContent = "Guardar nueva contraseña"; }
  }

  async function handleLogout() {
    await db.logout();
    state.user = state.profile = null;
    showAuth("login");
  }

  async function enterApp(session) {
    state.user = session.user; state.profile = session.profile;
    await refreshData();
    $("#authScreen").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    applyPermissions();
    updateUserUI();
    showView("dashboard");
    refreshFxRate().then(() => renderCurrentView());
  }

  function showAuth(mode) {
    $("#appShell").classList.add("hidden");
    $("#authScreen").classList.remove("hidden");
    $$(".auth-form").forEach(f => f.classList.remove("active"));
    const map = {login:"#loginForm",forgot:"#forgotForm",recover:"#recoverForm"};
    $(map[mode] || "#loginForm").classList.add("active");
  }
  function showRecoverScreen(){ showAuth("recover"); }

  async function refreshData() {
    const data = await db.load();
    state.companies = data.companies || [];
    state.projects = data.projects || [];
    state.extras = data.extras || [];
    state.payments = data.payments || [];
    state.users = data.users || [];
    state.activities = data.activities || [];
    populateFilters();
  }

  function applyPermissions() {
    $$(".admin-only").forEach(el => el.classList.toggle("hidden",!isAdmin()));
    $("#paymentsHeading").textContent = isAdmin() ? "Pagos a colaboradores" : "Mis pagos";
    $("#paymentsSubheading").textContent = isAdmin() ? "Control privado de pagos pendientes y realizados." : "Solo tú puedes ver tus pagos asignados.";
  }

  function updateUserUI() {
    const name = state.profile.full_name;
    const title = state.profile.job_title_en || (isAdmin()?"Administrator":"Collaborator");
    $("#headerAvatar").textContent = initials(name); $("#accountAvatar").textContent = initials(name);
    $("#headerUserName").textContent = name; $("#headerUserRole").textContent = title;
    $("#accountName").textContent = name; $("#accountTitle").textContent = title;
    $("#welcomeHeading").textContent = `Hola, ${name.split(" ")[0]}.`;
    $("#welcomeText").textContent = isAdmin() ? "Aquí tienes el estado actualizado del negocio, proyectos y pagos." : "Aquí tienes tus proyectos asignados, extras y pagos privados.";
    $("#profileData").innerHTML = `
      <div class="profile-line"><span>Usuario</span><strong>${esc(state.profile.username || "")}</strong></div>
      <div class="profile-line"><span>Correo de acceso</span><strong>${esc(state.profile.contact_email || "No registrado")}</strong></div>
      <div class="profile-line"><span>Rol</span><strong>${isAdmin()?"Administrator":"Collaborator"}</strong></div>
      <div class="profile-line"><span>Cargo</span><strong>${esc(title)}</strong></div>
      <div class="profile-line"><span>Sistema</span><strong>Private Cloud Database</strong></div>`;
  }

  function showView(view) {
    if (view === "users" && !isAdmin()) view = "dashboard";
    state.currentView = view;
    $$(".view").forEach(el => el.classList.toggle("active",el.id === `view-${view}`));
    $$(".nav-item").forEach(el => el.classList.toggle("active",el.dataset.view === view));
    const titles = {
      dashboard:["Dashboard","Resumen general"],companies:["Empresas","Base de clientes"],projects:["Proyectos","Control de trabajo"],extras:["Extras","Adicionales por proyecto"],payments:[isAdmin()?"Pagos":"Mis pagos","Control financiero privado"],users:["Usuarios y permisos","Administradores y colaboradores"],account:["Mi cuenta","Perfil y seguridad"]
    };
    $("#viewTitle").textContent = titles[view][0]; $("#viewKicker").textContent = titles[view][1];
    $("#sidebar").classList.remove("open");
    renderCurrentView();
  }

  function renderCurrentView() {
    ({dashboard:renderDashboard,companies:renderCompanies,projects:renderProjects,extras:renderExtras,payments:renderPayments,users:renderUsers,account:updateUserUI}[state.currentView] || (()=>{}))();
  }

  function currencyTotals(items, amountKey, filter = () => true) {
    const totals = {};
    items.filter(filter).forEach(item => totals[item.currency || "USD"] = (totals[item.currency || "USD"] || 0) + Number(item[amountKey] || 0));
    return Object.entries(totals).map(([c,v]) => formatMoney(v,c)).join(" · ") || formatMoney(0,"USD");
  }

  function projectExtrasTotal(projectId, key="client_price") {
    return state.extras.filter(e=>e.project_id===projectId).reduce((sum,e)=>sum+Number(e[key]||0),0);
  }
  function projectTotalAmount(p) {
    const extrasTotal = state.extras.filter(e=>e.project_id===p.id && e.billable_to_client).reduce((sum,e)=>sum+Number(e.client_price||0),0);
    return Number(p.quoted_amount||0) + extrasTotal;
  }

  function renderDashboard() {
    const visibleProjects = state.projects;
    const active = visibleProjects.filter(p => !["completed","cancelled"].includes(p.status)).length;
    const pendingClosure = visibleProjects.filter(p => p.status === "pending_closure").length;
    const pendingPaymentStatus = visibleProjects.filter(p => p.status === "pending_payment").length;

    const clientCollectedByCurrency = {}, clientBalanceByCurrency = {};
    visibleProjects.forEach(p => {
      const total = projectTotalAmount(p);
      const collected = Number(p.client_paid||0);
      clientCollectedByCurrency[p.currency||"USD"] = (clientCollectedByCurrency[p.currency||"USD"]||0) + collected;
      clientBalanceByCurrency[p.currency||"USD"] = (clientBalanceByCurrency[p.currency||"USD"]||0) + Math.max(0,total-collected);
    });
    state.extras.filter(e=>e.billable_to_client && e.client_status==="paid").forEach(e=>clientCollectedByCurrency[e.currency||"USD"]=(clientCollectedByCurrency[e.currency||"USD"]||0)+Number(e.client_price||0));
    const clientCollected = Object.entries(clientCollectedByCurrency).map(([c,v])=>formatMoney(v,c)).join(" · ") || formatMoney(0,"USD");
    const clientBalance = Object.entries(clientBalanceByCurrency).map(([c,v])=>formatMoney(v,c)).join(" · ") || formatMoney(0,"USD");

    const collaboratorPaid = currencyTotals(state.payments,"amount",p=>p.status==="paid");
    const collaboratorPending = currencyTotals(state.payments,"amount",p=>p.status!=="paid");

    const stats = isAdmin() ? [
      ["◆","Proyectos activos",active,"En curso"],
      ["◷","Pendientes de pago",pendingPaymentStatus,"Proyectos"],
      ["✓","Pendientes de cierre",pendingClosure,"Revisión final"],
      ["$","Total cobrado a clientes",clientCollected,"Acumulado"],
      ["→","Pendiente por cobrar",clientBalance,"Clientes"],
      ["✔","Total pagado a colaboradores",collaboratorPaid,"Acumulado"],
      ["◔","Pendiente por pagar",collaboratorPending,"Colaboradores"]
    ] : [
      ["◆","Mis proyectos activos",active,"Asignados"],
      ["＋","Mis extras",state.extras.length,"Trabajos adicionales"],
      ["→","Mis pagos pendientes",collaboratorPending,"Privado"],
      ["✓","Proyectos completados",state.projects.filter(p=>p.status==="completed").length,"Finalizados"]
    ];
    $("#statsGrid").innerHTML = stats.map(([icon,label,value,trend])=>`<article class="stat-card"><div class="stat-top"><span>${esc(label)}</span><div class="stat-icon">${icon}</div></div><strong>${value}</strong><span class="stat-trend">${esc(trend)}</span></article>`).join("");

    const counts = Object.fromEntries(PROJECT_STATUSES.map(([key])=>[key,state.projects.filter(p=>p.status===key).length]));
    const max = Math.max(1,...Object.values(counts));
    $("#pipelineChart").innerHTML = PROJECT_STATUSES.map(([key,label])=>`<div class="pipeline-row"><span>${label}</span><div class="pipeline-track"><div class="pipeline-fill" style="width:${(counts[key]/max)*100}%"></div></div><strong>${counts[key]}</strong></div>`).join("");

    if (isAdmin()) {
      const collaborators = state.users.filter(u=>u.active);
      const byCollab = collaborators.map(u=>({name:u.full_name,count:state.projects.filter(p=>p.assigned_to===u.id && !["completed","cancelled"].includes(p.status)).length}));
      const maxC = Math.max(1,...byCollab.map(x=>x.count));
      $("#collaboratorBreakdown").innerHTML = byCollab.length ? byCollab.map(x=>`<div class="pipeline-row"><span>${esc(x.name)}</span><div class="pipeline-track"><div class="pipeline-fill" style="width:${(x.count/maxC)*100}%"></div></div><strong>${x.count}</strong></div>`).join("") : empty("No hay colaboradores activos");
    }

    const pending = state.payments.filter(p=>p.status!=="paid").sort((a,b)=>(a.due_date||"9999").localeCompare(b.due_date||"9999")).slice(0,5);
    $("#pendingPaymentsList").innerHTML = pending.length ? pending.map(p=>`<div class="mini-item"><div class="mini-icon">$</div><div><strong>${esc(p.concept)}</strong><small>${formatMoney(p.amount,p.currency)} · ${formatDate(p.due_date)}</small></div></div>`).join("") : empty("No hay pagos pendientes");

    const activities = state.activities.slice(0,6);
    $("#activityList").innerHTML = activities.length ? activities.map(a=>`<div class="activity-item"><div class="mini-icon">↗</div><div><strong>${esc(a.action)}</strong><small>${new Date(a.created_at).toLocaleString("es-AR")}</small></div></div>`).join("") : empty("Todavía no hay actividad");

    const deadlines = state.projects.filter(p=>p.due_date && !["completed","cancelled"].includes(p.status)).sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,5);
    $("#deadlinesList").innerHTML = deadlines.length ? deadlines.map(p=>`<div class="mini-item"><div class="mini-icon">◷</div><div><strong>${esc(p.title)}</strong><small>${formatDate(p.due_date)} · ${statusLabel(p.status)}</small></div></div>`).join("") : empty("No hay vencimientos próximos");
  }

  function renderCompanies() {
    const q = $("#companySearch").value.trim().toLowerCase();
    const rows = state.companies.filter(c=>[c.name,c.contact_name,c.email,c.phone,c.address].join(" ").toLowerCase().includes(q));
    $("#companiesGrid").innerHTML = rows.length ? rows.map(c=>{
      const projectCount = state.projects.filter(p=>p.company_id===c.id).length;
      return `<article class="data-card"><div class="data-card-head"><div><h3>${esc(c.name)}</h3><p>${esc(c.contact_name||"Sin contacto")}</p></div><span class="status-chip active">${projectCount} proyecto${projectCount===1?"":"s"}</span></div><div class="card-meta"><div class="meta-line"><span>Correo</span><strong>${esc(c.email||"—")}</strong></div><div class="meta-line"><span>Teléfono</span><strong>${esc(c.phone||"—")}</strong></div><div class="meta-line"><span>Dirección</span><strong>${esc(c.address||"—")}</strong></div><div class="meta-line"><span>Notas</span><strong>${esc(c.notes||"—")}</strong></div></div>${isAdmin()?`<div class="card-actions"><button class="btn outline" data-action="edit-company" data-id="${c.id}">Editar</button><button class="btn danger" data-action="delete-company" data-id="${c.id}">Eliminar</button></div>`:""}</article>`;
    }).join("") : empty("No se encontraron empresas");
  }

  function renderProjects() {
    const q=$("#projectSearch").value.trim().toLowerCase(), status=$("#projectStatusFilter").value, assignee=$("#projectAssigneeFilter").value;
    const company=$("#projectCompanyFilter").value, workType=$("#projectWorkTypeFilter").value, currency=$("#projectCurrencyFilter").value;
    const dateFrom=$("#projectDateFrom").value, dateTo=$("#projectDateTo").value;
    const rows=state.projects.filter(p=>{
      const companyLabel=companyName(p.company_id).toLowerCase();
      if (!([p.title,p.work_type,companyLabel].join(" ").toLowerCase().includes(q))) return false;
      if (status!=="all" && p.status!==status) return false;
      if (isAdmin() && assignee!=="all" && p.assigned_to!==assignee) return false;
      if (company!=="all" && p.company_id!==company) return false;
      if (workType!=="all" && p.work_type!==workType) return false;
      if (currency!=="all" && (p.currency||"USD")!==currency) return false;
      if (dateFrom && (!p.due_date || p.due_date<dateFrom)) return false;
      if (dateTo && (!p.due_date || p.due_date>dateTo)) return false;
      return true;
    });
    $("#projectsTable").innerHTML = rows.length ? rows.map(p=>{
      const total=projectTotalAmount(p);
      return `<tr><td class="row-title"><strong>${esc(p.title)}</strong><small>${esc(p.work_type||"")}</small></td><td>${esc(companyName(p.company_id))}</td><td>${esc(userName(p.assigned_to))}</td><td><span class="status-chip ${statusClass(p.status)}">${statusLabel(p.status)}</span></td><td>${isAdmin()?`${formatMoney(total,p.currency)}<br><small class="muted">Pagado: ${formatMoney(p.client_paid,p.currency)}</small>`:'<span class="status-chip">Información administrativa</span>'}</td><td>${formatDate(p.due_date)}</td><td><button class="btn outline" data-action="view-tasks" data-id="${p.id}">Tareas</button> ${isAdmin()?`<button class="btn outline" data-action="edit-project" data-id="${p.id}">Editar</button> <button class="btn danger" data-action="delete-project" data-id="${p.id}">Eliminar</button>`:""}</td></tr>`;
    }).join("") : `<tr><td colspan="7">${empty("No se encontraron proyectos")}</td></tr>`;
  }

  function renderExtras() {
    const q=$("#extraSearch").value.trim().toLowerCase(), status=$("#extraStatusFilter").value, currency=$("#extraCurrencyFilter").value;
    const rows=state.extras.filter(e=>{
      if (!([e.title,e.description,projectName(e.project_id)].join(" ").toLowerCase().includes(q))) return false;
      if (status!=="all" && e.client_status!==status) return false;
      if (currency!=="all" && (e.currency||"USD")!==currency) return false;
      return true;
    });
    $("#extrasGrid").innerHTML=rows.length?rows.map(e=>`<article class="data-card"><div class="data-card-head"><div><h3>${esc(e.title)}</h3><p>${esc(projectName(e.project_id))}</p></div><span class="status-chip ${statusClass(e.client_status)}">${e.client_status==="paid"?"Pagado":"Pendiente"}</span></div><div class="card-meta"><div class="meta-line"><span>Fecha</span><strong>${formatDate(e.extra_date)}</strong></div><div class="meta-line"><span>Precio al cliente</span><strong>${isAdmin()?formatMoney(e.client_price,e.currency):"Información administrativa"}</strong></div><div class="meta-line"><span>Monto colaborador</span><strong>${(isAdmin()||e.assigned_to===state.profile.id)?formatMoney(e.collaborator_amount,e.currency):"—"}</strong></div><div class="meta-line"><span>Responsable</span><strong>${esc(userName(e.assigned_to))}</strong></div><div class="meta-line"><span>Cobrar al cliente</span><strong>${e.billable_to_client?"Sí":"No"}</strong></div><div class="meta-line"><span>Detalle</span><strong>${esc(e.description||"—")}</strong></div>${e.notes?`<div class="meta-line"><span>Notas</span><strong>${esc(e.notes)}</strong></div>`:""}</div>${isAdmin()?`<div class="card-actions"><button class="btn outline" data-action="edit-extra" data-id="${e.id}">Editar</button><button class="btn danger" data-action="delete-extra" data-id="${e.id}">Eliminar</button></div>`:""}</article>`).join(""):empty("No se encontraron extras");
  }

  function renderPayments() {
    const q=$("#paymentSearch").value.trim().toLowerCase(), status=$("#paymentStatusFilter").value, user=$("#paymentUserFilter").value;
    const currency=$("#paymentCurrencyFilter").value, dateFrom=$("#paymentDateFrom").value, dateTo=$("#paymentDateTo").value;
    const rows=state.payments.filter(p=>{
      if (!([p.concept,projectName(p.project_id),userName(p.collaborator_id)].join(" ").toLowerCase().includes(q))) return false;
      if (status!=="all" && p.status!==status) return false;
      if (isAdmin() && user!=="all" && p.collaborator_id!==user) return false;
      if (currency!=="all" && (p.currency||"USD")!==currency) return false;
      const refDate = p.paid_date || p.due_date;
      if (dateFrom && (!refDate || refDate<dateFrom)) return false;
      if (dateTo && (!refDate || refDate>dateTo)) return false;
      return true;
    });
    const pending=currencyTotals(rows,"amount",p=>p.status!=="paid"), paid=currencyTotals(rows,"amount",p=>p.status==="paid");
    $("#paymentSummary").innerHTML=`<article class="summary-card"><span>Pendiente</span><strong>${pending}</strong></article><article class="summary-card"><span>Pagado</span><strong>${paid}</strong></article><article class="summary-card"><span>Registros</span><strong>${rows.length}</strong></article>`;
    const statusText = {paid:"Pagado",partial:"Parcial",pending:"Pendiente"};
    $("#paymentsTable").innerHTML=rows.length?rows.map(p=>`<tr><td>${esc(userName(p.collaborator_id))}</td><td class="row-title"><strong>${esc(p.concept)}</strong><small>${esc(p.payment_method||"")}${p.reference?` · ${esc(p.reference)}`:""}</small></td><td>${esc(projectName(p.project_id)||"Sin proyecto")}</td><td>${formatMoney(p.amount,p.currency)}</td><td><span class="status-chip ${statusClass(p.status)}">${statusText[p.status]||"Pendiente"}</span></td><td>${formatDate(p.due_date)}</td><td>${isAdmin()?`<button class="btn outline" data-action="edit-payment" data-id="${p.id}">Editar</button> ${p.receipt_path?`<button class="btn outline" data-action="view-receipt" data-id="${p.id}">📎 Comprobante</button> `:""}<button class="btn danger" data-action="delete-payment" data-id="${p.id}">Eliminar</button>`:(p.receipt_path?`<button class="btn outline" data-action="view-receipt" data-id="${p.id}">📎 Ver comprobante</button>`:"—")}</td></tr>`).join(""):`<tr><td colspan="7">${empty("No se encontraron pagos")}</td></tr>`;
  }

  function renderUsers() {
    if (!isAdmin()) return;
    $("#usersGrid").innerHTML=state.users.length?state.users.map(u=>`<article class="data-card"><div class="data-card-head"><div style="display:flex;gap:12px;align-items:center"><span class="avatar">${initials(u.full_name)}</span><div><h3>${esc(u.full_name)}</h3><p>${esc(u.job_title_en||"")}</p></div></div><span class="status-chip ${u.active?"active":"pending"}">${u.active?"Activo":"Inactivo"}</span></div><div class="card-meta"><div class="meta-line"><span>Usuario</span><strong>${esc(u.username||"—")}</strong></div><div class="meta-line"><span>Correo de acceso</span><strong>${esc(u.contact_email||"—")}</strong></div><div class="meta-line"><span>Rol</span><strong>${u.role==="admin"?"Administrator":"Collaborator"}</strong></div><div class="meta-line"><span>Proyectos</span><strong>${state.projects.filter(p=>p.assigned_to===u.id).length}</strong></div></div>${u.id===state.profile.id?`<div class="card-actions"><button class="btn outline" data-action="edit-user" data-id="${u.id}">Editar</button><span class="muted" style="font-size:.78rem">Este eres tú — cambia tu contraseña desde "Mi cuenta".</span></div>`:`<div class="card-actions"><button class="btn outline" data-action="edit-user" data-id="${u.id}">Editar</button><button class="btn outline" data-action="reset-user-password" data-id="${u.id}">Nueva clave</button><button class="btn ${u.active?"danger":"primary"}" data-action="toggle-user" data-id="${u.id}">${u.active?"Desactivar":"Activar"}</button></div>`}</article>`).join(""):empty("No hay usuarios registrados");
  }

  function populateFilters() {
    $("#projectStatusFilter").innerHTML=`<option value="all">Todos los estados</option>${PROJECT_STATUSES.map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}`;
    const collaborators=state.users.filter(u=>u.active);
    const options=collaborators.map(u=>`<option value="${u.id}">${esc(u.full_name)}</option>`).join("");
    $("#projectAssigneeFilter").innerHTML=`<option value="all">Todos los colaboradores</option>${options}`;
    $("#paymentUserFilter").innerHTML=`<option value="all">Todos los colaboradores</option>${options}`;
    const companyOptions = state.companies.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#projectCompanyFilter").innerHTML=`<option value="all">Todas las empresas</option>${companyOptions}`;
    const workTypes = [...new Set(state.projects.map(p=>p.work_type).filter(Boolean))].sort();
    $("#projectWorkTypeFilter").innerHTML=`<option value="all">Todos los tipos de trabajo</option>${workTypes.map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join("")}`;
  }

  function companyName(id){return state.companies.find(c=>c.id===id)?.name||"Sin empresa"}
  function projectName(id){return state.projects.find(p=>p.id===id)?.title||""}
  function userName(id){ return state.users.find(u=>u.id===id)?.full_name || (state.profile?.id===id ? state.profile.full_name : "Sin asignar"); }
  function empty(message){return `<div class="empty-state"><strong>${esc(message)}</strong><span>Los registros aparecerán aquí.</span></div>`}

  function openModal(type,id=null) {
    if (["company","project","extra","payment","user"].includes(type) && !isAdmin()) return;
    const record = getRecord(type,id);
    state.modal={type,id};
    const modalData=modalTemplate(type,record);
    $("#modalKicker").textContent=id?"Editar registro":"Nuevo registro";
    $("#modalTitle").textContent=modalData.title;
    $("#modalForm").innerHTML=modalData.html;
    $("#modalBackdrop").classList.remove("hidden");
    $("#modalForm").onsubmit=event=>handleModalSubmit(event,type,id);
  }
  function closeModal(){ $("#modalBackdrop").classList.add("hidden"); state.modal=null; }

  async function openTasksModal(projectId) {
    const project = state.projects.find(p=>p.id===projectId);
    if(!project){toast("No se encontró el proyecto.","error");return;}
    state.modal={type:"tasks",id:projectId};
    $("#modalKicker").textContent="Tareas del proyecto";
    $("#modalTitle").textContent=project.title;
    $("#modalForm").onsubmit=event=>event.preventDefault();
    const taskSuggestions = ["Diseño web","Logotipo","Tarjetas de presentación","Manejo de redes sociales","Contenido para redes","Diseño de flyer","Edición de video","Fotografía","Mantenimiento web","Hosting y dominio","SEO básico","Cotización","Entrega final"];
    $("#modalForm").innerHTML=`
      <div class="task-list field-full" id="taskList"><p class="muted">Cargando tareas…</p></div>
      <div class="task-add-row field-full">
        <input type="text" id="newTaskTitle" list="taskSuggestions" placeholder="Nueva tarea… (elige o escribe)">
        <datalist id="taskSuggestions">${taskSuggestions.map(t=>`<option value="${esc(t)}">`).join("")}</datalist>
        <select id="newTaskAssignee">${optionList(state.users.filter(u=>u.active),"id","full_name",project.assigned_to)}</select>
        <button type="button" id="addTaskBtn" class="btn primary">Agregar</button>
      </div>
      <div class="modal-actions"><button type="button" class="btn outline" onclick="document.getElementById('closeModalBtn').click()">Cerrar</button></div>`;
    $("#modalBackdrop").classList.remove("hidden");
    $("#addTaskBtn").addEventListener("click",async()=>{
      const input=$("#newTaskTitle");
      const title=input.value.trim();
      const assignedTo=$("#newTaskAssignee").value;
      if(!title)return;
      try{ await db.createTask(projectId,title,assignedTo); input.value=""; await renderTaskList(projectId); }
      catch(e){toast(e.message||"No se pudo agregar la tarea.","error");}
    });
    $("#newTaskTitle").addEventListener("keydown",event=>{
      if(event.key==="Enter"){ event.preventDefault(); $("#addTaskBtn").click(); }
    });
    await renderTaskList(projectId);
  }

  async function renderTaskList(projectId) {
    const container=$("#taskList");
    if(!container)return;
    try {
      const tasks=await db.loadTasks(projectId);
      container.innerHTML = tasks.length ? tasks.map(t=>`
        <div class="task-item ${t.done?"done":""}">
          <label class="task-check"><input type="checkbox" data-task-id="${t.id}" ${t.done?"checked":""}><span>${esc(t.title)}<small class="task-assignee">👤 ${esc(userName(t.assigned_to))}</small></span></label>
          <button type="button" class="icon-button" data-task-delete="${t.id}" aria-label="Eliminar tarea">×</button>
        </div>`).join("") : `<p class="muted">Todavía no hay tareas para este proyecto.</p>`;
      $$("input[data-task-id]",container).forEach(input=>input.addEventListener("change",async()=>{
        try{ await db.toggleTask(input.dataset.taskId,input.checked); await renderTaskList(projectId); }
        catch(e){toast(e.message||"No se pudo actualizar la tarea.","error");}
      }));
      $$("[data-task-delete]",container).forEach(btn=>btn.addEventListener("click",async()=>{
        if(!confirm("¿Eliminar esta tarea?"))return;
        try{ await db.deleteTask(btn.dataset.taskDelete); await renderTaskList(projectId); }
        catch(e){toast(e.message||"No se pudo eliminar la tarea.","error");}
      }));
    } catch(e) {
      container.innerHTML = `<p class="muted">No se pudieron cargar las tareas.</p>`;
    }
  }

  function getRecord(type,id){
    const map={company:state.companies,project:state.projects,extra:state.extras,payment:state.payments,user:state.users};
    return id?(map[type]||[]).find(x=>x.id===id):null;
  }
  const optionList=(items,value,label,selected)=>items.map(x=>`<option value="${esc(x[value])}" ${x[value]===selected?"selected":""}>${esc(x[label])}</option>`).join("");
  const statusOptions=selected=>PROJECT_STATUSES.map(([k,v])=>`<option value="${k}" ${k===selected?"selected":""}>${v}</option>`).join("");
  const currencyOptions=selected=>CURRENCIES.map(c=>`<option value="${c}" ${c===selected?"selected":""}>${c}</option>`).join("");
  const paymentMethodOptions=selected=>PAYMENT_METHODS.map(m=>`<option value="${esc(m)}" ${m===selected?"selected":""}>${m}</option>`).join("");
  const paymentStatusOptions=selected=>`<option value="pending" ${selected!=="paid"&&selected!=="partial"?"selected":""}>Pendiente</option><option value="partial" ${selected==="partial"?"selected":""}>Parcial</option><option value="paid" ${selected==="paid"?"selected":""}>Pagado</option>`;

  function modalTemplate(type,r={}) {
    r=r||{};
    const save=`<div class="modal-actions"><button type="button" class="btn outline" onclick="document.getElementById('closeModalBtn').click()">Cancelar</button><button type="submit" class="btn primary">Guardar</button></div>`;
    if(type==="company")return{title:r.id?"Editar empresa":"Agregar empresa",html:`<label>Empresa<input name="name" required value="${esc(r.name||"")}"></label><label>Persona de contacto<input name="contact_name" value="${esc(r.contact_name||"")}"></label><label>Correo<input name="email" type="email" value="${esc(r.email||"")}"></label><label>Teléfono<input name="phone" value="${esc(r.phone||"")}"></label><label class="field-full">Dirección<input name="address" value="${esc(r.address||"")}"></label><label class="field-full">Notas internas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="project")return{title:r.id?"Editar proyecto":"Nuevo proyecto",html:`<label>Nombre del proyecto<input name="title" required value="${esc(r.title||"")}"></label><label>Empresa<select name="company_id" required><option value="">Seleccionar</option>${optionList(state.companies,"id","name",r.company_id)}</select></label><label>Tipo de trabajo<input name="work_type" required value="${esc(r.work_type||"")}" placeholder="Web Design & Development"></label><label>Responsable<select name="assigned_to" required>${optionList(state.users.filter(u=>u.active),"id","full_name",r.assigned_to||(!isAdmin()?state.profile.id:""))}</select></label><label>Estado<select name="status">${statusOptions(r.status||"not_started")}</select></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Monto acordado<input name="quoted_amount" type="number" min="0" step="0.01" value="${r.quoted_amount||0}"></label><label>Pagado por el cliente<input name="client_paid" type="number" min="0" step="0.01" value="${r.client_paid||0}"></label><label>Fecha de inicio<input name="start_date" type="date" value="${r.start_date||today()}"></label><label>Fecha límite<input name="due_date" type="date" value="${r.due_date||""}"></label><label class="field-full">Descripción<textarea name="description">${esc(r.description||"")}</textarea></label><label class="field-full">Notas internas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="extra")return{title:r.id?"Editar extra":"Agregar extra",html:`<label>Proyecto<select name="project_id" required>${optionList(state.projects,"id","title",r.project_id)}</select></label><label>Responsable<select name="assigned_to" required>${optionList(state.users.filter(u=>u.active),"id","full_name",r.assigned_to)}</select></label><label>Nombre del extra<input name="title" required value="${esc(r.title||"")}"></label><label>Fecha<input name="extra_date" type="date" value="${r.extra_date||today()}"></label><label>Precio cobrado al cliente<input name="client_price" type="number" min="0" step="0.01" required value="${r.client_price||0}"></label><label>Monto para el colaborador<input name="collaborator_amount" type="number" min="0" step="0.01" required value="${r.collaborator_amount||0}"></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Estado de cobro<select name="client_status"><option value="pending" ${r.client_status!=="paid"?"selected":""}>Pendiente</option><option value="paid" ${r.client_status==="paid"?"selected":""}>Pagado</option></select></label><label>Cobrar al cliente<select name="billable_to_client"><option value="true" ${r.billable_to_client!==false?"selected":""}>Sí</option><option value="false" ${r.billable_to_client===false?"selected":""}>No</option></select></label><label class="field-full">Descripción<textarea name="description">${esc(r.description||"")}</textarea></label><label class="field-full">Notas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="payment")return{title:r.id?"Editar pago":"Registrar pago",html:`<label>Colaborador<select name="collaborator_id" required>${optionList(state.users.filter(u=>u.active),"id","full_name",r.collaborator_id)}</select></label><label>Proyecto<select name="project_id"><option value="">Sin proyecto</option>${optionList(state.projects,"id","title",r.project_id)}</select></label><label>Concepto<input name="concept" required value="${esc(r.concept||"")}"></label><label>Monto<input name="amount" type="number" min="0" step="0.01" required value="${r.amount||0}"></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Método de pago<select name="payment_method">${paymentMethodOptions(r.payment_method)}</select></label><label>Estado<select name="status">${paymentStatusOptions(r.status)}</select></label><label>Comprobante o referencia (texto)<input name="reference" value="${esc(r.reference||"")}"></label><label>Vencimiento<input name="due_date" type="date" value="${r.due_date||""}"></label><label>Fecha de pago<input name="paid_date" type="date" value="${r.paid_date||""}"></label><label class="field-full">Adjuntar comprobante (foto, PDF o Excel)<input type="file" name="receipt_file" accept="image/*,.pdf,.xlsx,.xls,.csv"></label>${r.receipt_name?`<p class="field-full muted">Comprobante actual: ${esc(r.receipt_name)} — <button type="button" class="link-button" data-action="view-receipt" data-id="${r.id}">ver</button>. Elige otro archivo arriba para reemplazarlo.</p>`:""}<label class="field-full">Notas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="user"){
      const isSelf = r.id && r.id===state.profile.id;
      return{title:r.id?"Editar usuario":"Crear usuario",html:`<label>Nombre completo<input name="full_name" required value="${esc(r.full_name||"")}"></label><label>Usuario<input name="username" required pattern="[a-z0-9._-]+" value="${esc(r.username||"")}" ${r.id?"readonly":""} placeholder="daniel.perez"></label><label>Email real (acceso y recuperación)<input name="contact_email" type="email" required value="${esc(r.contact_email||"")}" ${r.id?"readonly":""} placeholder="nombre.apellido@solidobusiness.com"></label><label>Cargo<input name="job_title_en" required value="${esc(r.job_title_en||"")}" placeholder="Web Developer & Graphic Designer"></label>${!isSelf?`<label>Permiso<select name="role"><option value="collaborator" ${r.role!=="admin"?"selected":""}>Collaborator — acceso privado</option><option value="admin" ${r.role==="admin"?"selected":""}>Administrator — puede ver y administrar todo</option></select></label>`:""}${!r.id?`<label>Contraseña temporal<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>`:""}${!isSelf?`<label>Estado<select name="active"><option value="true" ${r.active!==false?"selected":""}>Activo</option><option value="false" ${r.active===false?"selected":""}>Inactivo</option></select></label>`:""}${isSelf?`<p class="field-full muted">Tu permiso (Administrator) y estado no se pueden cambiar desde aquí, para que no pierdas el acceso por accidente. Pide a otro administrador si necesitas cambiarlos.</p>`:""}${save}`};
    }
    return{title:"Registro",html:save};
  }

  async function handleModalSubmit(event,type,id) {
    event.preventDefault();
    const button=event.submitter; button.disabled=true; button.textContent="Guardando…";
    try {
      const formData=new FormData(event.target);
      const receiptFile = type==="payment" ? formData.get("receipt_file") : null;
      formData.delete("receipt_file");
      const form=Object.fromEntries(formData.entries());
      ["quoted_amount","client_paid","amount","client_price","collaborator_amount"].forEach(k=>{if(k in form)form[k]=Number(form[k]||0)});
      // Los campos de fecha y las referencias opcionales (ej. "Sin proyecto") llegan como
      // cadena vacía "" desde el formulario, pero Postgres rechaza "" para columnas date/uuid.
      // Los convertimos a null para que se guarden correctamente como "sin valor".
      ["start_date","due_date","paid_date","extra_date","project_id"].forEach(k=>{if(k in form && form[k]==="")form[k]=null;});
      if("billable_to_client" in form)form.billable_to_client=form.billable_to_client==="true";
      if("active" in form)form.active=form.active==="true";
      let savedId=id;
      if(type==="user") {
        form.username = normalizeUsername(form.username);
        if(id) await db.upsert("profiles",{full_name:form.full_name,job_title_en:form.job_title_en,role:form.role,active:form.active},id);
        else await db.createUser(form);
      } else {
        const table={company:"companies",project:"projects",extra:"extras",payment:"payments"}[type];
        const payload={...form,created_by:state.profile.id};
        if(type==="project"&&!isAdmin()) payload.assigned_to=state.profile.id;
        savedId = await db.upsert(table,payload,id);
      }
      if(type==="payment" && receiptFile && receiptFile.size>0) {
        const paymentId = id || savedId;
        if (paymentId) await db.uploadReceipt(paymentId,receiptFile);
      }
      await logActivity(`${id?"Actualizó":"Creó"} ${typeLabel(type)}${form.title?`: ${form.title}`:""}`);
      closeModal(); await refreshData(); renderCurrentView(); toast("Cambios guardados correctamente.");
    } catch(error){console.error(error);toast(error.message||"No se pudo guardar.","error");}
    finally{button.disabled=false;button.textContent="Guardar";}
  }
  const typeLabel=type=>({company:"una empresa",project:"un proyecto",extra:"un extra",payment:"un pago",user:"un usuario"}[type]||"un registro");

  async function handleAction(button) {
    const {action,id}=button.dataset;
    if(action.startsWith("edit-")){openModal(action.replace("edit-",""),id);return;}
    if(action==="view-tasks"){openTasksModal(id);return;}
    if(action==="view-receipt"){
      const payment=state.payments.find(p=>p.id===id);
      if(!payment?.receipt_path){toast("Este pago no tiene comprobante adjunto.","error");return;}
      try{const url=await db.getReceiptUrl(payment.receipt_path);window.open(url,"_blank");}
      catch(e){toast(e.message||"No se pudo abrir el comprobante.","error");}
      return;
    }
    if(action==="reset-user-password"){
      const user=state.users.find(u=>u.id===id); if(!user)return;
      const password=prompt(`Nueva contraseña temporal para ${user.full_name}:`);
      if(!password)return;
      if(password.length<8){toast("La contraseña debe tener al menos 8 caracteres.","error");return;}
      try{await db.resetUserPassword(id,password);toast("Contraseña temporal actualizada.");}catch(e){toast(e.message||"No se pudo restablecer la contraseña.","error");}
      return;
    }
    if(action==="toggle-user"){
      const user=state.users.find(u=>u.id===id); if(!user)return;
      try{await db.upsert("profiles",{active:!user.active},id);await refreshData();renderUsers();toast(user.active?"Usuario desactivado.":"Usuario aprobado.");}catch(e){toast(e.message,"error");}return;
    }
    if(action.startsWith("delete-")){
      const type=action.replace("delete-","");
      const table={company:"companies",project:"projects",extra:"extras",payment:"payments"}[type];
      if(!confirm("¿Eliminar este registro? Esta acción no se puede deshacer."))return;
      try{await db.remove(table,id);await logActivity(`Eliminó ${typeLabel(type)}`);await refreshData();renderCurrentView();toast("Registro eliminado.");}catch(e){toast(e.message,"error");}
    }
  }

  async function handleChangePassword(event) {
    event.preventDefault();
    const p=$("#newPassword").value,c=$("#confirmPassword").value;
    if(p!==c){toast("Las contraseñas no coinciden.","error");return;}
    try{await db.changePassword(p);event.target.reset();toast("Contraseña actualizada de forma segura.");}catch(e){toast(e.message,"error");}
  }

  function exportBackup() {
    if(!isAdmin())return;
    const payload={exported_at:new Date().toISOString(),companies:state.companies,projects:state.projects,extras:state.extras,payments:state.payments,users:state.users,activities:state.activities};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`solido-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);
    toast("Respaldo descargado.");
  }

  initialize();
})();
