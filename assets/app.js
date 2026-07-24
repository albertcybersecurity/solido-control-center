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
  // Ciclo de vida de una tarea: pendiente → en progreso (la persona le dio "Iniciar
  // tarea") → completada (le dio "Tarea terminada"). Cada cambio se registra en el
  // historial de actividad (ver updateMyTaskStatus más abajo).
  const TASK_STATUS_META = {
    pending: {label:"Pendiente", chip:"pending"},
    in_progress: {label:"En progreso", chip:"waiting"},
    completed: {label:"Completada", chip:"completed"}
  };
  const taskStatusLabel = value => TASK_STATUS_META[value]?.label || "Pendiente";
  const taskStatusChip = value => TASK_STATUS_META[value]?.chip || "pending";

  const state = {
    user: null,
    profile: null,
    companies: [],
    projects: [],
    extras: [],
    payments: [],
    users: [],
    activities: [],
    myTasks: [],
    currentView: "dashboard",
    modal: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  // Fecha local en formato YYYY-MM-DD. OJO: no usar new Date().toISOString() para
  // esto, porque toISOString() convierte a UTC y en Argentina (UTC-3) eso hace que
  // cualquier hora después de las 21:00 devuelva la fecha de MAÑANA en vez de hoy
  // (ej: precargar mal la fecha de inicio de un proyecto nuevo creado de noche).
  const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const today = () => localDateStr(new Date());
  const initials = name => String(name || "U").split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join("").toUpperCase();
  const formatDate = value => value ? new Intl.DateTimeFormat("es-AR", {day:"2-digit",month:"short",year:"numeric"}).format(new Date(`${value}T12:00:00`)) : "Sin fecha";
  const statusLabel = value => PROJECT_STATUSES.find(([key]) => key === value)?.[1] || value || "Sin estado";
  const statusClass = value => ({completed:"completed",cancelled:"cancelled",pending_payment:"pending",pending_closure:"waiting",awaiting_client:"waiting",awaiting_approval:"waiting",not_started:"pending",started:"waiting",in_progress:"waiting",paid:"paid",partial:"partial",pending:"pending",active:"active"}[value] || "");
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
  // "viewer" = usuario de prueba: puede entrar y ver absolutamente todo (empresas,
  // proyectos, tareas, extras, pagos) igual que un administrador, pero nunca recibe
  // los montos de dinero reales (ver projects_for_viewer/extras_for_viewer/
  // payments_for_viewer en la base de datos, que directamente omiten esas columnas)
  // y no puede crear, editar ni borrar nada (sin políticas de escritura en la base).
  const isViewer = () => state.profile?.role === "viewer";
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
      let companies, projects, extras, payments, activities;
      if (isViewer()) {
        // El viewer no tiene política de lectura directa sobre projects/project_extras/
        // payments (por eso NO se consultan esas tablas directamente: devolverían 0
        // filas). En su lugar entra por estas tres funciones, que sí devuelven todas
        // las filas pero sin columnas de dinero — el monto real nunca viaja por la red.
        const [c,p,e,pay] = await Promise.all([
          supabaseClient.from("companies").select("*").order("created_at",{ascending:false}),
          supabaseClient.rpc("projects_for_viewer"),
          supabaseClient.rpc("extras_for_viewer"),
          supabaseClient.rpc("payments_for_viewer")
        ]);
        [companies,projects,extras,payments] = [c,p,e,pay].map(r => { if (r.error) throw r.error; return r.data || []; });
        activities = []; // el viewer no genera ni necesita ver notificaciones
      } else {
        const tables = ["companies","projects","project_extras","payments","activities"];
        const results = await Promise.all(tables.map(async table => {
          const {data,error} = await supabaseClient.from(table).select("*").order("created_at",{ascending:false});
          if (error) throw error;
          return data || [];
        }));
        [companies,projects,extras,payments,activities] = results;
      }
      let users = [];
      if (isAdmin()) {
        const {data,error} = await supabaseClient.from("profiles").select("*").order("created_at",{ascending:true});
        if (error) throw error;
        users = data || [];
      } else {
        // Un colaborador (o viewer) solo puede leer su propio perfil completo (RLS),
        // pero necesita ver nombres de otras personas (proyectos/tareas de otros, o
        // "Responsable" en cada fila). Sin esto, esos casos mostrarían "Sin asignar".
        // directory_names() solo expone id+nombre.
        const {data:directory} = await supabaseClient.rpc("directory_names");
        const others = (directory || []).filter(d => d.id !== state.profile.id).map(d => ({id:d.id, full_name:d.full_name, active:true}));
        users = [state.profile, ...others];
      }
      // Panel "Tareas pendientes" del Dashboard: tareas de CUALQUIER proyecto que me
      // fueron asignadas a mí, con el nombre del proyecto y de la empresa ya incluidos
      // (se resuelven con el join automático de PostgREST vía las foreign keys).
      const {data:myTasksData,error:myTasksError} = await supabaseClient
        .from("tasks")
        .select("*, projects(title, assigned_to, companies(name))")
        .eq("assigned_to", state.profile.id)
        .order("created_at",{ascending:true});
      if (myTasksError) throw myTasksError;
      const myTasks = myTasksData || [];
      return {companies,projects,extras,payments,activities,users,myTasks};
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
    async createTask(projectId,title,assignedTo,instructions){
      const {error} = await supabaseClient.from("tasks").insert({project_id:projectId,title,created_by:state.profile.id,assigned_to:assignedTo||state.profile.id,instructions:instructions||null});
      if (error) throw error;
    },
    async toggleTask(id,done){
      // El casillero de la lista de tareas (dentro de cada proyecto) sigue siendo
      // binario, pero ahora también mantiene sincronizado el nuevo estado de 3 pasos:
      // marcarla hace done=true/status="completed", desmarcarla la vuelve a "pending".
      const {error} = await supabaseClient.from("tasks").update({done,status:done?"completed":"pending",updated_at:new Date().toISOString()}).eq("id",id);
      if (error) throw error;
    },
    async setTaskStatus(id,status){
      const {error} = await supabaseClient.from("tasks").update({status,done:status==="completed",updated_at:new Date().toISOString()}).eq("id",id);
      if (error) throw error;
    },
    async deleteTask(id){
      const {error} = await supabaseClient.from("tasks").delete().eq("id",id);
      if (error) throw error;
    },
    // Bitácora de avance: quien tiene la tarea va anotando qué llevó hecho mientras
    // trabaja, y eso queda visible (con su nombre y fecha) para quien la asignó.
    async loadTaskNotes(taskId){
      const {data,error} = await supabaseClient
        .from("task_notes")
        .select("*, profiles:author_id(full_name)")
        .eq("task_id",taskId)
        .order("created_at",{ascending:true});
      if (error) throw error;
      return data || [];
    },
    async addTaskNote(taskId,note){
      const {error} = await supabaseClient.from("task_notes").insert({task_id:taskId,author_id:state.profile.id,note});
      if (error) throw error;
    },
    // Campana de notificaciones: marca como "vistas" todas las notificaciones propias
    // que todavía no se habían leído (se usa cuando el usuario abre la campana).
    async markNotificationsRead(){
      const {error} = await supabaseClient.from("activities").update({read_at:new Date().toISOString()}).eq("actor_id",state.profile.id).is("read_at",null);
      if (error) throw error;
    }
  };

  const db = supabaseDb;

  async function logActivity(action, forUserId) {
    try {
      await db.upsert("activities",{actor_id:forUserId||state.profile.id,action,created_by:state.profile.id});
    } catch (error) {
      console.warn("No se pudo registrar actividad",error);
    }
  }
  // Alerta simple para otra persona (ej. "se te asignó esta tarea", "se registró tu pago").
  // Queda guardada como actividad de ESA persona; ella la ve en su propio panel
  // "Actividad reciente" al entrar (cada quien solo ve la suya, salvo administradores).
  function notify(userId, message) {
    if (!userId || userId === state.profile.id) return;
    logActivity(message, userId);
  }

  // ==========================================================================
  // Campana de notificaciones. Muestra los avisos dirigidos a la persona que
  // inició sesión (asignación de tareas, pagos registrados, etc — los mismos
  // que ya se guardaban con notify()), con contador de "no leídas", sonido y
  // aviso del sistema operativo cuando llega uno nuevo.
  //
  // OJO con el alcance: esto avisa mientras el navegador/pestaña siga abierto
  // (aunque esté en segundo plano) usando Supabase Realtime + la Notification
  // API del navegador. Si el navegador está completamente cerrado no llega
  // nada — eso requeriría además un service worker con Push API y un backend
  // que dispare el envío (infraestructura aparte, no incluida acá).
  // ==========================================================================
  let notifChannel = null;
  let notifAudioCtx = null;

  function playNotifSound() {
    try {
      notifAudioCtx = notifAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = notifAudioCtx;
      const now = ctx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine"; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i*0.14);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i*0.14 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i*0.14 + 0.22);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + i*0.14); osc.stop(now + i*0.14 + 0.24);
      });
    } catch(e) { /* audio no disponible en este navegador, no es crítico */ }
  }

  function unreadNotifications() {
    return (state.activities||[]).filter(a => a.actor_id===state.profile.id && !a.read_at);
  }

  function renderNotifBadge() {
    const badge = $("#notifBadge");
    if (!badge) return;
    const count = unreadNotifications().length;
    badge.textContent = count > 9 ? "9+" : count;
    badge.classList.toggle("hidden", count===0);
  }

  function renderNotifDropdownList() {
    const list = $("#notifList");
    if (!list) return;
    const own = (state.activities||[]).filter(a => a.actor_id===state.profile.id).slice(0,20);
    list.innerHTML = own.length ? own.map(a => `
      <div class="notif-item ${a.read_at?"":"unread"}">
        <p>${esc(a.action)}</p>
        <small>${new Date(a.created_at).toLocaleString("es-AR")}</small>
      </div>`).join("") : `<p class="muted">No tenés notificaciones todavía.</p>`;
    const enableBtn = $("#notifEnableBtn");
    if (enableBtn) enableBtn.classList.toggle("hidden", !("Notification" in window) || Notification.permission !== "default");
  }

  async function toggleNotifDropdown() {
    const dropdown = $("#notifDropdown");
    if (!dropdown) return;
    const opening = dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden", !opening);
    if (!opening) return;
    renderNotifDropdownList();
    if (unreadNotifications().length) {
      try {
        await db.markNotificationsRead();
        const now = new Date().toISOString();
        state.activities.forEach(a => { if (a.actor_id===state.profile.id && !a.read_at) a.read_at = now; });
        renderNotifBadge();
        renderNotifDropdownList();
      } catch(e) { /* si falla, no pasa nada grave: se reintenta la próxima vez que abra la campana */ }
    }
  }

  function requestNotifPermission() {
    if (!("Notification" in window)) { toast("Este navegador no admite notificaciones del sistema.","error"); return; }
    Notification.requestPermission().then(() => renderNotifDropdownList());
  }

  // Se dispara cuando llega una fila nueva a "activities" dirigida a esta persona
  // (Supabase Realtime). Actualiza el estado local, hace sonar la campana y, si
  // el permiso está concedido, muestra un aviso del sistema operativo.
  function handleIncomingNotification(row) {
    if (!row || row.actor_id !== state.profile.id) return;
    if ((state.activities||[]).some(a => a.id===row.id)) return; // ya lo teníamos (evita duplicar por reconexión)
    state.activities = [row, ...(state.activities||[])];
    renderNotifBadge();
    if (!$("#notifDropdown")?.classList.contains("hidden")) renderNotifDropdownList();
    playNotifSound();
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("Sólido Control", {body: row.action, icon: "assets/solido-logo.jpeg"}); } catch(e) { /* algunos navegadores requieren un service worker; se ignora si falla */ }
    }
  }

  function initNotifications() {
    renderNotifBadge();
    if (!supabaseClient || notifChannel) return;
    notifChannel = supabaseClient
      .channel(`activities-for-${state.profile.id}`)
      .on("postgres_changes", {event:"INSERT", schema:"public", table:"activities", filter:`actor_id=eq.${state.profile.id}`}, payload => handleIncomingNotification(payload.new))
      .subscribe();
  }

  function teardownNotifications() {
    if (notifChannel) { supabaseClient?.removeChannel(notifChannel); notifChannel = null; }
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
      // Cerrar la campana de notificaciones si se toca afuera de ella.
      if (!event.target.closest(".notif-wrap")) $("#notifDropdown")?.classList.add("hidden");
    });
    $("#notifBellBtn").addEventListener("click",event => { event.stopPropagation(); toggleNotifDropdown(); });
    $("#notifEnableBtn").addEventListener("click",requestNotifPermission);
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
    teardownNotifications();
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
    initNotifications();
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
    state.myTasks = data.myTasks || [];
    populateFilters();
  }

  function applyPermissions() {
    $$(".admin-only").forEach(el => el.classList.toggle("hidden",!isAdmin()));
    $("#paymentsHeading").textContent = isAdmin() ? "Pagos a colaboradores" : (isViewer() ? "Pagos" : "Mis pagos");
    $("#paymentsSubheading").textContent = isAdmin() ? "Control privado de pagos pendientes y realizados." : (isViewer() ? "Modo de solo lectura: ves todos los registros, pero los montos están ocultos." : "Solo tú puedes ver tus pagos asignados.");
  }

  function updateUserUI() {
    const name = state.profile.full_name;
    const title = state.profile.job_title_en || (isAdmin()?"Administrator":isViewer()?"Viewer":"Collaborator");
    $("#headerAvatar").textContent = initials(name); $("#accountAvatar").textContent = initials(name);
    $("#headerUserName").textContent = name; $("#headerUserRole").textContent = title;
    $("#accountName").textContent = name; $("#accountTitle").textContent = title;
    $("#welcomeHeading").textContent = `Hola, ${name.split(" ")[0]}.`;
    $("#welcomeText").textContent = isAdmin() ? "Aquí tienes el estado actualizado del negocio, proyectos y pagos." : isViewer() ? "Modo de solo lectura: puedes ver todo el negocio, pero los montos de dinero están ocultos." : "Aquí tienes tus proyectos asignados, extras y pagos privados.";
    $("#profileData").innerHTML = `
      <div class="profile-line"><span>Usuario</span><strong>${esc(state.profile.username || "")}</strong></div>
      <div class="profile-line"><span>Correo de acceso</span><strong>${esc(state.profile.contact_email || "No registrado")}</strong></div>
      <div class="profile-line"><span>Rol</span><strong>${isAdmin()?"Administrator":isViewer()?"Viewer (solo lectura, sin montos)":"Collaborator"}</strong></div>
      <div class="profile-line"><span>Cargo</span><strong>${esc(title)}</strong></div>
      <div class="profile-line"><span>Sistema</span><strong>Private Cloud Database</strong></div>`;
  }

  function showView(view) {
    if (view === "users" && !isAdmin()) view = "dashboard";
    state.currentView = view;
    $$(".view").forEach(el => el.classList.toggle("active",el.id === `view-${view}`));
    $$(".nav-item").forEach(el => el.classList.toggle("active",el.dataset.view === view));
    const titles = {
      dashboard:["Dashboard","Resumen general"],tasks:["Tareas pendientes","Tu trabajo asignado"],companies:["Empresas","Base de clientes"],projects:["Proyectos","Control de trabajo"],extras:["Extras","Adicionales por proyecto"],payments:[isAdmin()?"Pagos":(isViewer()?"Pagos":"Mis pagos"),isViewer()?"Solo lectura, sin montos":"Control financiero privado"],users:["Usuarios y permisos","Administradores y colaboradores"],account:["Mi cuenta","Perfil y seguridad"]
    };
    $("#viewTitle").textContent = titles[view][0]; $("#viewKicker").textContent = titles[view][1];
    $("#sidebar").classList.remove("open");
    renderCurrentView();
  }

  function renderCurrentView() {
    ({dashboard:renderDashboard,tasks:renderTasksView,companies:renderCompanies,projects:renderProjects,extras:renderExtras,payments:renderPayments,users:renderUsers,account:updateUserUI}[state.currentView] || (()=>{}))();
  }

  function currencyTotals(items, amountKey, filter = () => true) {
    const totals = {};
    const getValue = typeof amountKey === "function" ? amountKey : item => Number(item[amountKey] || 0);
    items.filter(filter).forEach(item => totals[item.currency || "USD"] = (totals[item.currency || "USD"] || 0) + Number(getValue(item) || 0));
    return Object.entries(totals).map(([c,v]) => formatMoney(v,c)).join(" · ") || formatMoney(0,"USD");
  }

  function projectExtrasTotal(projectId, key="client_price") {
    return state.extras.filter(e=>e.project_id===projectId).reduce((sum,e)=>sum+Number(e[key]||0),0);
  }
  function projectTotalAmount(p) {
    const extrasTotal = state.extras.filter(e=>e.project_id===p.id && e.billable_to_client).reduce((sum,e)=>sum+Number(e.client_price||0),0);
    return Number(p.quoted_amount||0) + extrasTotal;
  }
  // Lo acordado con el cliente (arriba) y lo acordado con el colaborador (aquí) son dos
  // cosas distintas: cuánto se le cobra al cliente por el proyecto vs. cuánto se le paga
  // al colaborador que lo hace. Esto calcula, para el colaborador, cuánto ya se le abonó
  // (sumando "paid_amount" de todos los pagos ligados a este proyecto, no solo los que ya
  // están 100% "Pagado" — un pago "Parcial" también tiene una parte ya abonada).
  function projectCollaboratorPaid(p) {
    return state.payments.filter(pay=>pay.project_id===p.id).reduce((sum,pay)=>sum+Number(pay.paid_amount||0),0);
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

    // "Pagado" suma lo realmente abonado (paid_amount) en TODOS los pagos, no solo los que
    // ya están 100% "Pagado" — un pago "Parcial" también aporta lo que ya se entregó.
    // "Pendiente" es lo que falta de cada pago (monto total pactado menos lo abonado).
    const collaboratorPaid = currencyTotals(state.payments,"paid_amount");
    const collaboratorPending = currencyTotals(state.payments, pay => Math.max(0, Number(pay.amount||0) - Number(pay.paid_amount||0)));

    const stats = isAdmin() ? [
      ["◆","Proyectos activos",active,"En curso"],
      ["◷","Pendientes de pago",pendingPaymentStatus,"Proyectos"],
      ["✓","Pendientes de cierre",pendingClosure,"Revisión final"],
      ["$","Total cobrado a clientes",clientCollected,"Acumulado"],
      ["→","Pendiente por cobrar",clientBalance,"Clientes"],
      ["✔","Total pagado a colaboradores",collaboratorPaid,"Acumulado"],
      ["◔","Pendiente por pagar",collaboratorPending,"Colaboradores"]
    ] : isViewer() ? [
      ["◆","Proyectos activos",active,"En curso"],
      ["⛁","Empresas",state.companies.length,"Clientes"],
      ["＋","Extras registrados",state.extras.length,"Trabajos adicionales"],
      ["✓","Proyectos completados",state.projects.filter(p=>p.status==="completed").length,"Finalizados"]
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
      const collaborators = state.users.filter(u=>u.active && u.role!=="viewer");
      const byCollab = collaborators.map(u=>({name:u.full_name,count:state.projects.filter(p=>p.assigned_to===u.id && !["completed","cancelled"].includes(p.status)).length}));
      const maxC = Math.max(1,...byCollab.map(x=>x.count));
      $("#collaboratorBreakdown").innerHTML = byCollab.length ? byCollab.map(x=>`<div class="pipeline-row"><span>${esc(x.name)}</span><div class="pipeline-track"><div class="pipeline-fill" style="width:${(x.count/maxC)*100}%"></div></div><strong>${x.count}</strong></div>`).join("") : empty("No hay colaboradores activos");
    }

    const pending = state.payments.filter(p=>p.status!=="paid").sort((a,b)=>(a.due_date||"9999").localeCompare(b.due_date||"9999")).slice(0,5);
    $("#pendingPaymentsList").innerHTML = pending.length ? pending.map(p=>{
      const owed = Math.max(0, Number(p.amount||0)-Number(p.paid_amount||0));
      return `<div class="mini-item"><div class="mini-icon">$</div><div><strong>${esc(p.concept)}</strong><small>${isViewer()?"Monto oculto":formatMoney(owed,p.currency)} · ${formatDate(p.due_date)}</small></div></div>`;
    }).join("") : empty("No hay pagos pendientes");

    const activities = state.activities.slice(0,6);
    $("#activityList").innerHTML = activities.length ? activities.map(a=>`<div class="activity-item"><div class="mini-icon">↗</div><div><strong>${esc(a.action)}</strong><small>${new Date(a.created_at).toLocaleString("es-AR")}</small></div></div>`).join("") : empty("Todavía no hay actividad");

    // "Próximos vencimientos": antes mezclaba fechas ya pasadas (vencidas) junto con
    // las futuras sin ninguna distinción visual, lo que hacía parecer que el panel
    // mostraba datos incorrectos cuando en realidad algunos proyectos ya estaban
    // vencidos. Ahora se marca claramente cada proyecto vencido con una etiqueta roja
    // "Vencido" para que se note de inmediato cuál necesita atención urgente.
    const todayStr = today();
    const deadlines = state.projects.filter(p=>p.due_date && !["completed","cancelled"].includes(p.status)).sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,5);
    $("#deadlinesList").innerHTML = deadlines.length ? deadlines.map(p=>{
      const overdue = p.due_date < todayStr;
      return `<div class="mini-item"><div class="mini-icon">◷</div><div><strong>${esc(p.title)}</strong><small>${formatDate(p.due_date)} · ${statusLabel(p.status)}</small></div>${overdue?`<span class="status-chip overdue" style="margin-left:auto;flex:0 0 auto">Vencido</span>`:""}</div>`;
    }).join("") : empty("No hay vencimientos próximos");

    renderMyTasks();
    updateTasksNavBadge();
  }

  // Panel "Tareas pendientes" del Dashboard: muestra las tareas asignadas a la
  // persona que inició sesión (de cualquier proyecto/empresa), con un botón para
  // avanzar el estado: Pendiente → (Iniciar tarea) → En progreso → (Tarea
  // terminada) → Completada. Cada paso queda registrado en "Actividad reciente".
  // Tocar el texto de la tarea (no el botón) abre el detalle completo, con las
  // instrucciones y la bitácora de avance.
  function renderMyTasks() {
    const list = $("#myTasksList");
    if (!list) return;
    const rows = (state.myTasks||[]).filter(t=>t.status!=="completed").sort((a,b)=>{
      const order = {in_progress:0,pending:1};
      return (order[a.status]??1)-(order[b.status]??1) || (a.created_at||"").localeCompare(b.created_at||"");
    });
    list.innerHTML = rows.length ? rows.map(t=>taskRowHtml(t)).join("") : empty("No tienes tareas pendientes");
  }

  // Vista completa "Tareas pendientes" en el menú principal: TODAS las tareas
  // asignadas a la persona (incluye las ya completadas, al final y atenuadas),
  // para poder revisar el historial completo, no solo lo pendiente.
  function renderTasksView() {
    const list = $("#tasksFullList");
    if (!list) return;
    const rows = [...(state.myTasks||[])].sort((a,b)=>{
      const order = {in_progress:0,pending:1,completed:2};
      return (order[a.status]??1)-(order[b.status]??1) || (a.created_at||"").localeCompare(b.created_at||"");
    });
    list.innerHTML = rows.length ? rows.map(t=>taskRowHtml(t)).join("") : empty("No tenés tareas asignadas todavía.");
    updateTasksNavBadge();
  }

  function taskRowHtml(t) {
    const projectTitle = t.projects?.title || "Sin proyecto";
    const companyName = t.projects?.companies?.name || "Sin empresa";
    const actionBtn = (isViewer() || t.status==="completed") ? "" : t.status==="pending"
      ? `<button class="btn outline" data-action="start-task" data-id="${t.id}">Iniciar tarea</button>`
      : `<button class="btn primary" data-action="complete-task" data-id="${t.id}">Tarea terminada</button>`;
    return `<div class="task-item ${t.status==="completed"?"done":""}">
      <span class="task-check" style="cursor:pointer" data-action="open-task" data-id="${t.id}"><span>${esc(t.title)}<small class="task-assignee">🏢 ${esc(companyName)} · ${esc(projectTitle)}</small>${t.instructions?`<small class="task-assignee">📋 ${esc(t.instructions)}</small>`:""}</span></span>
      <span class="status-chip ${taskStatusChip(t.status)}">${taskStatusLabel(t.status)}</span>
      ${actionBtn}
    </div>`;
  }

  // Contador en el ícono del menú lateral: cuántas tareas están pendientes o en
  // progreso ahora mismo, para que se note de un vistazo sin tener que entrar.
  function updateTasksNavBadge() {
    const badge = $("#tasksNavBadge");
    if (!badge) return;
    const count = (state.myTasks||[]).filter(t=>t.status!=="completed").length;
    badge.textContent = count;
    badge.classList.toggle("hidden",count===0);
  }

  // Detalle de una tarea: instrucciones de quien la asignó, bitácora de avance
  // (donde quien la ejecuta va anotando qué llevó hecho mientras trabaja), y el
  // botón para pasar de pendiente → en progreso → completada.
  async function openTaskDetail(taskId) {
    const task = (state.myTasks||[]).find(t=>t.id===taskId);
    if (!task) { toast("No se encontró la tarea.","error"); return; }
    state.modal = {type:"task-detail", id:taskId};
    const projectTitle = task.projects?.title || "Sin proyecto";
    const companyName = task.projects?.companies?.name || "Sin empresa";
    $("#modalKicker").textContent = "Tarea";
    $("#modalTitle").textContent = task.title;
    $("#modalForm").onsubmit = event => event.preventDefault();
    $("#modalForm").innerHTML = `
      <div class="field-full">
        <p class="muted">🏢 ${esc(companyName)} · ${esc(projectTitle)}</p>
        <span class="status-chip ${taskStatusChip(task.status)}">${taskStatusLabel(task.status)}</span>
      </div>
      ${task.instructions ? `<div class="field-full"><label>Instrucciones de quien asignó la tarea</label><p class="task-instructions-block">${esc(task.instructions)}</p></div>` : ""}
      <div class="field-full">
        <label>Avance de la tarea</label>
        <div id="taskNotesList" class="task-notes-list"><p class="muted">Cargando…</p></div>
        ${(!isViewer() && task.status!=="completed") ? `
        <div class="task-note-add">
          <textarea id="newTaskNoteText" placeholder="Anotá qué llevás hecho…"></textarea>
          <button type="button" id="addTaskNoteBtn" class="btn outline">Agregar avance</button>
        </div>` : ""}
      </div>
      <div class="modal-actions" id="taskDetailActions"></div>`;
    $("#modalBackdrop").classList.remove("hidden");
    renderTaskDetailActions(task);
    await loadAndRenderTaskNotes(taskId);
    const addBtn = $("#addTaskNoteBtn");
    if (addBtn) {
      addBtn.addEventListener("click", async (event) => {
        const btn = event.currentTarget;
        if (btn.disabled) return;
        const textarea = $("#newTaskNoteText");
        const note = textarea.value.trim();
        if (!note) return;
        btn.disabled = true;
        try {
          await db.addTaskNote(taskId, note);
          textarea.value = "";
          await loadAndRenderTaskNotes(taskId);
        } catch(e) { toast(e.message||"No se pudo guardar el avance.","error"); }
        finally { btn.disabled = false; }
      });
    }
  }

  function renderTaskDetailActions(task) {
    const el = $("#taskDetailActions");
    if (!el) return;
    if (isViewer() || task.status === "completed") { el.innerHTML = ""; return; }
    const label = task.status === "pending" ? "Iniciar tarea" : "Marcar como completada";
    const action = task.status === "pending" ? "start-task" : "complete-task";
    el.innerHTML = `<button type="button" class="btn primary" data-action="${action}" data-id="${task.id}">${label}</button>`;
  }

  async function loadAndRenderTaskNotes(taskId) {
    const list = $("#taskNotesList");
    if (!list) return;
    try {
      const notes = await db.loadTaskNotes(taskId);
      list.innerHTML = notes.length ? notes.map(n => `
        <div class="task-note-item">
          <strong>${esc(n.profiles?.full_name || "Alguien")}</strong>
          <small>${new Date(n.created_at).toLocaleString("es-AR")}</small>
          <p>${esc(n.note)}</p>
        </div>`).join("") : `<p class="muted">Todavía no hay avances anotados.</p>`;
    } catch(e) {
      list.innerHTML = `<p class="muted">No se pudo cargar el avance.</p>`;
    }
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
      const collabBudget=Number(p.collaborator_budget||0);
      const collabPaid=projectCollaboratorPaid(p);
      const collabPending=Math.max(0,collabBudget-collabPaid);
      const canSeeCollabPay = isAdmin() || p.assigned_to===state.profile.id;
      const collabCell = canSeeCollabPay ? `Acordado: ${formatMoney(collabBudget,p.currency)}<br><small class="muted">Pagado: ${formatMoney(collabPaid,p.currency)}</small><br><small class="${collabPending>0?'danger-text':'muted'}">${collabPending>0?`Falta: ${formatMoney(collabPending,p.currency)}`:"Al día"}</small>` : '<span class="status-chip">Información administrativa</span>';
      return `<tr><td class="row-title"><strong>${esc(p.title)}</strong><small>${esc(p.work_type||"")}</small></td><td>${esc(companyName(p.company_id))}</td><td>${esc(userName(p.assigned_to))}</td><td><span class="status-chip ${statusClass(p.status)}">${statusLabel(p.status)}</span></td><td>${isAdmin()?`${formatMoney(total,p.currency)}<br><small class="muted">Cobrado: ${formatMoney(p.client_paid,p.currency)}</small>`:'<span class="status-chip">Información administrativa</span>'}</td><td>${collabCell}</td><td>${formatDate(p.due_date)}</td><td><button class="btn outline" data-action="view-tasks" data-id="${p.id}">Tareas</button> ${isAdmin()?`<button class="btn outline" data-action="edit-project" data-id="${p.id}">Editar</button> <button class="btn danger" data-action="delete-project" data-id="${p.id}">Eliminar</button>`:""}</td></tr>`;
    }).join("") : `<tr><td colspan="8">${empty("No se encontraron proyectos")}</td></tr>`;
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
    // "Pendiente" = lo que falta de cada pago (monto total pactado menos lo ya abonado).
    // "Pagado" = suma de lo realmente abonado (paid_amount) en todos los pagos filtrados,
    // incluyendo la parte ya entregada de los que están "Parcial".
    const pending=isViewer()?"Oculto":currencyTotals(rows, p => Math.max(0, Number(p.amount||0) - Number(p.paid_amount||0)));
    const paid=isViewer()?"Oculto":currencyTotals(rows,"paid_amount");
    $("#paymentSummary").innerHTML=`<article class="summary-card"><span>Pendiente</span><strong>${pending}</strong></article><article class="summary-card"><span>Pagado</span><strong>${paid}</strong></article><article class="summary-card"><span>Registros</span><strong>${rows.length}</strong></article>`;
    const statusText = {paid:"Pagado",partial:"Parcial",pending:"Pendiente"};
    $("#paymentsTable").innerHTML=rows.length?rows.map(p=>`<tr><td>${esc(userName(p.collaborator_id))}</td><td class="row-title"><strong>${esc(p.concept)}</strong><small>${esc(p.payment_method||"")}${p.reference?` · ${esc(p.reference)}`:""}</small></td><td>${esc(projectName(p.project_id)||"Sin proyecto")}</td><td>${isViewer()?'<span class="status-chip">Oculto</span>':formatMoney(p.amount,p.currency)}</td><td>${isViewer()?'<span class="status-chip">Oculto</span>':formatMoney(p.paid_amount,p.currency)}</td><td><span class="status-chip ${statusClass(p.status)}">${statusText[p.status]||"Pendiente"}</span></td><td>${formatDate(p.due_date)}</td><td>${isAdmin()?`<button class="btn outline" data-action="edit-payment" data-id="${p.id}">Editar</button> ${p.receipt_path?`<button class="btn outline" data-action="view-receipt" data-id="${p.id}">📎 Comprobante</button> `:""}<button class="btn danger" data-action="delete-payment" data-id="${p.id}">Eliminar</button>`:(isViewer()?"—":(p.receipt_path?`<button class="btn outline" data-action="view-receipt" data-id="${p.id}">📎 Ver comprobante</button>`:"—"))}</td></tr>`).join(""):`<tr><td colspan="8">${empty("No se encontraron pagos")}</td></tr>`;
  }

  function renderUsers() {
    if (!isAdmin()) return;
    $("#usersGrid").innerHTML=state.users.length?state.users.map(u=>`<article class="data-card"><div class="data-card-head"><div style="display:flex;gap:12px;align-items:center"><span class="avatar">${initials(u.full_name)}</span><div><h3>${esc(u.full_name)}</h3><p>${esc(u.job_title_en||"")}</p></div></div><span class="status-chip ${u.active?"active":"pending"}">${u.active?"Activo":"Inactivo"}</span></div><div class="card-meta"><div class="meta-line"><span>Usuario</span><strong>${esc(u.username||"—")}</strong></div><div class="meta-line"><span>Correo de acceso</span><strong>${esc(u.contact_email||"—")}</strong></div><div class="meta-line"><span>Rol</span><strong>${u.role==="admin"?"Administrator":u.role==="viewer"?"Viewer":"Collaborator"}</strong></div><div class="meta-line"><span>Proyectos</span><strong>${state.projects.filter(p=>p.assigned_to===u.id).length}</strong></div></div>${u.id===state.profile.id?`<div class="card-actions"><button class="btn outline" data-action="edit-user" data-id="${u.id}">Editar</button><span class="muted" style="font-size:.78rem">Este eres tú — cambia tu contraseña desde "Mi cuenta".</span></div>`:`<div class="card-actions"><button class="btn outline" data-action="edit-user" data-id="${u.id}">Editar</button><button class="btn outline" data-action="reset-user-password" data-id="${u.id}">Nueva clave</button><button class="btn ${u.active?"danger":"primary"}" data-action="toggle-user" data-id="${u.id}">${u.active?"Desactivar":"Activar"}</button></div>`}</article>`).join(""):empty("No hay usuarios registrados");
  }

  function populateFilters() {
    $("#projectStatusFilter").innerHTML=`<option value="all">Todos los estados</option>${PROJECT_STATUSES.map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}`;
    const collaborators=state.users.filter(u=>u.active&&u.role!=="viewer");
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
    const taskSuggestions = ["Paquete Full Diseño Web","Diseño web","Logotipo","Tarjetas de presentación","Manejo de redes sociales","Contenido para redes","Diseño de flyer","Edición de video","Fotografía","Mantenimiento web","Hosting y dominio","SEO básico","Cotización","Entrega final"];
    // Igual que la política de la base de datos (tasks_collaborator_all_own): solo el
    // administrador o el dueño del proyecto pueden asignar tareas nuevas. Un
    // colaborador que solo tiene una tarea suya dentro de un proyecto ajeno puede ver
    // la lista, pero no debe ver el formulario de "agregar tarea" porque el guardado
    // fallaría en el servidor (permiso denegado) y se vería como un error confuso.
    const canManageProject = isAdmin() || project.assigned_to===state.profile.id;
    const addRow = (isViewer() || !canManageProject) ? "" : `
      <div class="task-add-row field-full">
        <input type="text" id="newTaskTitle" list="taskSuggestions" placeholder="Nueva tarea… (elige o escribe)">
        <datalist id="taskSuggestions">${taskSuggestions.map(t=>`<option value="${esc(t)}">`).join("")}</datalist>
        <select id="newTaskAssignee">${optionList(state.users.filter(u=>u.active&&u.role!=="viewer"),"id","full_name",project.assigned_to)}</select>
        <button type="button" id="addTaskBtn" class="btn primary">Agregar</button>
      </div>
      <div class="field-full">
        <label>Pasos e instrucciones para ejecutar la tarea (opcional)
          <textarea id="newTaskInstructions" placeholder="Ej: 1) Diseñar en Canva con la paleta de la empresa. 2) Exportar en PNG y JPG. 3) Enviar al cliente por correo para aprobación."></textarea>
        </label>
      </div>`;
    $("#modalForm").innerHTML=`
      <div class="task-list field-full" id="taskList"><p class="muted">Cargando tareas…</p></div>
      ${addRow}
      <div class="modal-actions"><button type="button" class="btn outline" onclick="document.getElementById('closeModalBtn').click()">Cerrar</button></div>`;
    $("#modalBackdrop").classList.remove("hidden");
    if (!isViewer()) {
      $("#addTaskBtn").addEventListener("click",async(event)=>{
        // Guard contra doble clic/doble toque (mismo problema que ya se corrigió en
        // los botones de iniciar/completar tarea): sin esto, tocar dos veces rápido
        // "Agregar" crea la misma tarea duplicada dos veces.
        const btn=event.currentTarget;
        if(btn.disabled)return;
        const input=$("#newTaskTitle");
        const title=input.value.trim();
        const assignedTo=$("#newTaskAssignee").value;
        const instructions=$("#newTaskInstructions").value.trim();
        if(!title)return;
        btn.disabled=true;
        try{
          await db.createTask(projectId,title,assignedTo,instructions);
          notify(assignedTo, `Se te asignó la tarea "${title}" en el proyecto "${project.title}".${instructions?" Tiene instrucciones, revísalas en la tarea.":""}`);
          input.value=""; $("#newTaskInstructions").value=""; await renderTaskList(projectId);
        }
        catch(e){toast(e.message||"No se pudo agregar la tarea.","error");}
        finally{btn.disabled=false;}
      });
      $("#newTaskTitle").addEventListener("keydown",event=>{
        if(event.key==="Enter"){ event.preventDefault(); $("#addTaskBtn").click(); }
      });
    }
    await renderTaskList(projectId);
  }

  async function renderTaskList(projectId) {
    const container=$("#taskList");
    if(!container)return;
    const project = state.projects.find(p=>p.id===projectId);
    // Debe reflejar exactamente el permiso real de la base de datos
    // (tasks_collaborator_all_own): admin, dueño del proyecto, o dueño de la tarea.
    const canManageProject = isAdmin() || (project && project.assigned_to===state.profile.id);
    const canEditTask = t => canManageProject || t.assigned_to===state.profile.id;
    try {
      const tasks=await db.loadTasks(projectId);
      container.innerHTML = tasks.length ? tasks.map(t=>{
        const editable = !isViewer() && canEditTask(t);
        return `
        <div class="task-item ${t.done?"done":""}">
          <label class="task-check"><input type="checkbox" data-task-id="${t.id}" data-task-title="${esc(t.title)}" ${t.done?"checked":""} ${editable?"":"disabled"}><span>${esc(t.title)}<small class="task-assignee">👤 ${esc(userName(t.assigned_to))} · <span class="status-chip ${taskStatusChip(t.status)}">${taskStatusLabel(t.status)}</span></small>${t.instructions?`<small class="task-assignee">📋 ${esc(t.instructions)}</small>`:""}</span></label>
          ${editable?`<button type="button" class="icon-button" data-task-delete="${t.id}" aria-label="Eliminar tarea">×</button>`:""}
        </div>`;
      }).join("") : `<p class="muted">Todavía no hay tareas para este proyecto.</p>`;
      if (!isViewer()) {
        $$("input[data-task-id]",container).forEach(input=>input.addEventListener("change",async(event)=>{
          // Mismo guard: deshabilitar el checkbox mientras se guarda evita que un
          // segundo toque rápido dispare otro toggle antes de que termine el primero.
          const box=event.currentTarget;
          box.disabled=true;
          try{
            await db.toggleTask(box.dataset.taskId,box.checked);
            if(box.checked && project) notify(project.assigned_to, `Se completó la tarea "${box.dataset.taskTitle}" en el proyecto "${project.title}".`);
            await renderTaskList(projectId);
          }
          catch(e){box.disabled=false;toast(e.message||"No se pudo actualizar la tarea.","error");}
        }));
        $$("[data-task-delete]",container).forEach(btn=>btn.addEventListener("click",async()=>{
          if(!confirm("¿Eliminar esta tarea?"))return;
          try{ await db.deleteTask(btn.dataset.taskDelete); await renderTaskList(projectId); }
          catch(e){toast(e.message||"No se pudo eliminar la tarea.","error");}
        }));
      }
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
    if(type==="project")return{title:r.id?"Editar proyecto":"Nuevo proyecto",html:`<label>Nombre del proyecto<input name="title" required value="${esc(r.title||"")}"></label><label>Empresa<select name="company_id" required><option value="">Seleccionar</option>${optionList(state.companies,"id","name",r.company_id)}</select></label><label>Tipo de trabajo<input name="work_type" required value="${esc(r.work_type||"")}" placeholder="Web Design & Development"></label><label>Responsable<select name="assigned_to" required>${optionList(state.users.filter(u=>u.active&&u.role!=="viewer"),"id","full_name",r.assigned_to||(!isAdmin()?state.profile.id:""))}</select></label><label>Estado<select name="status">${statusOptions(r.status||"not_started")}</select></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Monto acordado con el cliente<input name="quoted_amount" type="number" min="0" step="0.01" value="${r.quoted_amount||0}"></label><label>Cobrado al cliente<input name="client_paid" type="number" min="0" step="0.01" value="${r.client_paid||0}"></label><label>Monto acordado con el colaborador<input name="collaborator_budget" type="number" min="0" step="0.01" value="${r.collaborator_budget||0}"></label><label>Fecha de inicio<input name="start_date" type="date" value="${r.start_date||today()}"></label><label>Fecha límite<input name="due_date" type="date" value="${r.due_date||""}"></label><label class="field-full">Descripción<textarea name="description">${esc(r.description||"")}</textarea></label><label class="field-full">Notas internas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="extra")return{title:r.id?"Editar extra":"Agregar extra",html:`<label>Proyecto<select name="project_id" required>${optionList(state.projects,"id","title",r.project_id)}</select></label><label>Responsable<select name="assigned_to" required>${optionList(state.users.filter(u=>u.active&&u.role!=="viewer"),"id","full_name",r.assigned_to)}</select></label><label>Nombre del extra<input name="title" required value="${esc(r.title||"")}"></label><label>Fecha<input name="extra_date" type="date" value="${r.extra_date||today()}"></label><label>Precio cobrado al cliente<input name="client_price" type="number" min="0" step="0.01" required value="${r.client_price||0}"></label><label>Monto para el colaborador<input name="collaborator_amount" type="number" min="0" step="0.01" required value="${r.collaborator_amount||0}"></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Estado de cobro<select name="client_status"><option value="pending" ${r.client_status!=="paid"?"selected":""}>Pendiente</option><option value="paid" ${r.client_status==="paid"?"selected":""}>Pagado</option></select></label><label>Cobrar al cliente<select name="billable_to_client"><option value="true" ${r.billable_to_client!==false?"selected":""}>Sí</option><option value="false" ${r.billable_to_client===false?"selected":""}>No</option></select></label><label class="field-full">Descripción<textarea name="description">${esc(r.description||"")}</textarea></label><label class="field-full">Notas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="payment")return{title:r.id?"Editar pago":"Registrar pago",html:`<label>Colaborador<select name="collaborator_id" required>${optionList(state.users.filter(u=>u.active&&u.role!=="viewer"),"id","full_name",r.collaborator_id)}</select></label><label>Proyecto<select name="project_id"><option value="">Sin proyecto</option>${optionList(state.projects,"id","title",r.project_id)}</select></label><label>Concepto<input name="concept" required value="${esc(r.concept||"")}"></label><label>Monto total pactado<input name="amount" type="number" min="0" step="0.01" required value="${r.amount||0}"></label><label>Monto abonado hasta ahora<input name="paid_amount" type="number" min="0" step="0.01" value="${r.paid_amount||0}"></label><label>Moneda<select name="currency">${currencyOptions(r.currency||"USD")}</select></label><label>Método de pago<select name="payment_method">${paymentMethodOptions(r.payment_method)}</select></label><label>Estado<select name="status">${paymentStatusOptions(r.status)}</select></label><label>Comprobante o referencia (texto)<input name="reference" value="${esc(r.reference||"")}"></label><label>Vencimiento<input name="due_date" type="date" value="${r.due_date||""}"></label><label>Fecha de pago<input name="paid_date" type="date" value="${r.paid_date||""}"></label><label class="field-full">Adjuntar comprobante (foto, PDF o Excel)<input type="file" name="receipt_file" accept="image/*,.pdf,.xlsx,.xls,.csv"></label>${r.receipt_name?`<p class="field-full muted">Comprobante actual: ${esc(r.receipt_name)} — <button type="button" class="link-button" data-action="view-receipt" data-id="${r.id}">ver</button>. Elige otro archivo arriba para reemplazarlo.</p>`:""}<label class="field-full">Notas<textarea name="notes">${esc(r.notes||"")}</textarea></label>${save}`};
    if(type==="user"){
      const isSelf = r.id && r.id===state.profile.id;
      return{title:r.id?"Editar usuario":"Crear usuario",html:`<label>Nombre completo<input name="full_name" required value="${esc(r.full_name||"")}"></label><label>Usuario<input name="username" required pattern="[a-z0-9._-]+" value="${esc(r.username||"")}" ${r.id?"readonly":""} placeholder="daniel.perez"></label><label>Email real (acceso y recuperación)<input name="contact_email" type="email" required value="${esc(r.contact_email||"")}" ${r.id?"readonly":""} placeholder="nombre.apellido@solidobusiness.com"></label><label>Cargo<input name="job_title_en" required value="${esc(r.job_title_en||"")}" placeholder="Web Developer & Graphic Designer"></label>${!isSelf?`<label>Permiso<select name="role"><option value="collaborator" ${r.role!=="admin"&&r.role!=="viewer"?"selected":""}>Collaborator — acceso privado</option><option value="viewer" ${r.role==="viewer"?"selected":""}>Viewer — ve todo (sin montos de dinero), solo lectura</option><option value="admin" ${r.role==="admin"?"selected":""}>Administrator — puede ver y administrar todo</option></select></label>`:""}${!r.id?`<label>Contraseña temporal<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>`:""}${!isSelf?`<label>Estado<select name="active"><option value="true" ${r.active!==false?"selected":""}>Activo</option><option value="false" ${r.active===false?"selected":""}>Inactivo</option></select></label>`:""}${isSelf?`<p class="field-full muted">Tu permiso (Administrator) y estado no se pueden cambiar desde aquí, para que no pierdas el acceso por accidente. Pide a otro administrador si necesitas cambiarlos.</p>`:""}${save}`};
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
      ["quoted_amount","client_paid","amount","client_price","collaborator_amount","collaborator_budget","paid_amount"].forEach(k=>{if(k in form)form[k]=Number(form[k]||0)});
      // Los campos de fecha y las referencias opcionales (ej. "Sin proyecto") llegan como
      // cadena vacía "" desde el formulario, pero Postgres rechaza "" para columnas date/uuid.
      // Los convertimos a null para que se guarden correctamente como "sin valor".
      ["start_date","due_date","paid_date","extra_date","project_id"].forEach(k=>{if(k in form && form[k]==="")form[k]=null;});
      if("billable_to_client" in form)form.billable_to_client=form.billable_to_client==="true";
      if("active" in form)form.active=form.active==="true";
      // Si se marca el pago como "Pagado", forzamos que lo abonado sea igual al monto
      // total pactado — evita que quede desactualizado si alguien cambia el estado a
      // Pagado pero se olvida de actualizar el campo "Monto abonado".
      if(type==="payment" && form.status==="paid") form.paid_amount = form.amount;
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
      if(type==="payment") {
        const amountLabel = formatMoney(form.amount, form.currency||"USD").replace(/<[^>]*>/g,"").trim();
        if(!id) notify(form.collaborator_id, `Se registró un pago de ${amountLabel} para ti (${form.concept}).`);
        else {
          // Solo avisar cuando el estado recién pasa a "pagado" — comparamos contra el
          // valor previo (antes de este guardado) para no reenviar el aviso cada vez
          // que se edita cualquier otro campo de un pago que ya estaba pagado.
          const prevStatus = state.payments.find(pay=>pay.id===id)?.status;
          if(form.status==="paid" && prevStatus!=="paid") notify(form.collaborator_id, `Tu pago de ${amountLabel} (${form.concept}) fue marcado como pagado.`);
        }
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
    if(action==="open-task"){openTaskDetail(id);return;}
    if(action==="start-task"||action==="complete-task"){
      // Guard contra doble clic/doble toque: en celular es fácil tocar dos veces
      // seguidas antes de que el botón cambie de texto, y como el segundo toque cae
      // en el mismo lugar donde ya apareció "Tarea terminada", la tarea se iniciaba
      // Y se completaba de una sola vez. Deshabilitamos el botón apenas se toca una
      // vez, así el segundo toque (mientras el primero todavía está guardando) no
      // hace nada.
      if(button.disabled)return;
      const task=(state.myTasks||[]).find(t=>t.id===id); if(!task)return;
      button.disabled=true;
      const newStatus = action==="start-task" ? "in_progress" : "completed";
      try{
        await db.setTaskStatus(id,newStatus);
        const verb = newStatus==="in_progress" ? "inició" : "completó";
        const projectTitle = task.projects?.title || "";
        await logActivity(`${state.profile.full_name} ${verb} la tarea "${task.title}"${projectTitle?` (${projectTitle})`:""}`);
        // Avisarle a quien es dueño del proyecto (normalmente el admin que asignó la
        // tarea) que hubo movimiento, para que le llegue como notificación en su
        // propia campana en vez de tener que estar revisando manualmente.
        const projectOwner = task.projects?.assigned_to;
        if (projectOwner) notify(projectOwner, `${state.profile.full_name} ${verb} la tarea "${task.title}"${projectTitle?` (${projectTitle})`:""}.`);
        await refreshData();
        renderCurrentView();
        // Si la tarea se estaba viendo en el detalle (modal), lo refrescamos para que
        // muestre el nuevo estado y el botón correcto, en vez de quedar desactualizado.
        if (state.modal?.type==="task-detail" && state.modal.id===id) await openTaskDetail(id);
        toast(newStatus==="in_progress" ? "Tarea iniciada." : "¡Tarea completada!");
      }catch(e){button.disabled=false;toast(e.message||"No se pudo actualizar la tarea.","error");}
      return;
    }
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
    const button=event.submitter; if(button){button.disabled=true;button.textContent="Guardando…";}
    try{await db.changePassword(p);event.target.reset();toast("Contraseña actualizada de forma segura.");}
    catch(e){toast(e.message,"error");}
    finally{if(button){button.disabled=false;button.textContent="Actualizar contraseña";}}
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
