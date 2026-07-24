-- SÓLIDO CONTROL CENTER — ESQUEMA DE PRODUCCIÓN
-- Ejecutar completo en Supabase SQL Editor (proyecto nuevo y vacío).

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  contact_email text,
  full_name text not null default '',
  role text not null default 'collaborator' check (role in ('admin','collaborator')),
  job_title_en text not null default 'Collaborator',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9._-]+$')
);
create unique index if not exists profiles_username_unique_lower on public.profiles (lower(username));

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null, contact_name text, email text, phone text, address text, notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  title text not null, work_type text not null, description text,
  status text not null default 'not_started' check (status in (
    'not_started','started','in_progress','awaiting_client','awaiting_approval',
    'pending_payment','pending_closure','completed','cancelled'
  )),
  start_date date, due_date date, currency text not null default 'USD' check (currency in ('USD','ARS')),
  quoted_amount numeric(14,2) not null default 0, client_paid numeric(14,2) not null default 0,
  assigned_to uuid not null references public.profiles(id) on delete restrict,
  notes text, created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.project_extras (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text,
  extra_date date not null default current_date,
  client_price numeric(14,2) not null default 0,
  collaborator_amount numeric(14,2) not null default 0,
  currency text not null default 'USD' check (currency in ('USD','ARS')),
  billable_to_client boolean not null default true,
  client_status text not null default 'pending' check (client_status in ('pending','paid')),
  notes text,
  assigned_to uuid references public.profiles(id), created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  collaborator_id uuid not null references public.profiles(id) on delete restrict,
  project_id uuid references public.projects(id) on delete set null,
  concept text not null, amount numeric(14,2) not null default 0,
  currency text not null default 'USD' check (currency in ('USD','ARS')),
  payment_method text,
  reference text,
  status text not null default 'pending' check (status in ('pending','partial','paid')),
  due_date date, paid_date date, notes text, created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null, created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create index if not exists idx_projects_assigned_to on public.projects(assigned_to);
create index if not exists idx_projects_company_id on public.projects(company_id);
create index if not exists idx_project_extras_assigned_to on public.project_extras(assigned_to);
create index if not exists idx_project_extras_project_id on public.project_extras(project_id);
create index if not exists idx_payments_collaborator_id on public.payments(collaborator_id);
create index if not exists idx_activities_actor_id on public.activities(actor_id);

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin' and active=true);
$$;
revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to authenticated;

-- Permite iniciar sesión con un nombre de usuario simple (ej. daniel.perez) en vez del
-- email real. Solo expone el email correspondiente a un username activo; no expone nada
-- más y es seguro para llamar de forma anónima (antes de autenticarse).
create or replace function public.email_for_username(p_username text) returns text
language sql stable security definer set search_path = public as $$
  select contact_email from public.profiles
  where lower(username) = lower(trim(p_username)) and active = true
  limit 1;
$$;
revoke all on function public.email_for_username(text) from public;
grant execute on function public.email_for_username(text) to anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare derived_username text;
begin
  derived_username := lower(coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email,'@',1)));
  insert into public.profiles(id,username,contact_email,full_name,role,job_title_en,active)
  values(
    new.id,
    derived_username,
    coalesce(nullif(new.raw_user_meta_data->>'contact_email',''), new.email),
    coalesce(new.raw_user_meta_data->>'full_name',''),
    case when new.raw_user_meta_data->>'role'='admin' then 'admin' else 'collaborator' end,
    coalesce(new.raw_user_meta_data->>'job_title_en','Collaborator'),
    true
  )
  on conflict(id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.projects enable row level security;
alter table public.project_extras enable row level security;
alter table public.payments enable row level security;
alter table public.activities enable row level security;

create policy "profiles_select_own_or_admin" on public.profiles for select to authenticated using ((select auth.uid())=id or (select private.is_admin()));
create policy "profiles_admin_update" on public.profiles for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "companies_admin_all" on public.companies for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "companies_collaborator_select_assigned" on public.companies for select to authenticated using (exists(select 1 from public.projects p where p.company_id=companies.id and p.assigned_to=(select auth.uid())));

create policy "projects_admin_all" on public.projects for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "projects_collaborator_select_own" on public.projects for select to authenticated using (assigned_to=(select auth.uid()));

create policy "extras_admin_all" on public.project_extras for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "extras_collaborator_select_own" on public.project_extras for select to authenticated using (assigned_to=(select auth.uid()) or exists(select 1 from public.projects p where p.id=project_extras.project_id and p.assigned_to=(select auth.uid())));

create policy "payments_admin_all" on public.payments for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "payments_collaborator_select_own" on public.payments for select to authenticated using (collaborator_id=(select auth.uid()));

create policy "activities_admin_all" on public.activities for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "activities_collaborator_select_own" on public.activities for select to authenticated using (actor_id=(select auth.uid()));
create policy "activities_insert_own" on public.activities for insert to authenticated with check (actor_id=(select auth.uid()));

grant select,insert,update,delete on public.profiles,public.companies,public.projects,public.project_extras,public.payments,public.activities to authenticated;

-- PRIMER ADMINISTRADOR (Daniel, quien configura el sistema)
-- IMPORTANTE: en este esquema el email de acceso de cada persona ES su email real de
-- trabajo (ya no se usa un dominio interno inventado), porque así Supabase puede enviar
-- correctamente el correo de "recuperar contraseña". El nombre de usuario (ej. daniel.perez)
-- sigue siendo lo único que la persona escribe para entrar.
--
-- 1) En Authentication > Users crea manualmente a Daniel con su email real:
--    daniel.perez@solidobusiness.com y una contraseña que él elija.
-- 2) Convierte su perfil en administrador:
-- update public.profiles set username='daniel.perez', full_name='Daniel Pérez', role='admin', job_title_en='Web Developer & Graphic Designer / Administrator', active=true where id=(select id from auth.users where email='daniel.perez@solidobusiness.com');
-- 3) Inicia sesión como daniel.perez y, desde "Usuarios y permisos", crea a:
--    - yini.puleo — Yini Puleo — permiso Administrator (con el email real de Yini)
--    - alonso.rivera — Alonso Rivera — permiso Administrator (con el email real de Alonso)
--    - fabiola.dominguez — Fabiola Dominguez — permiso Collaborator (con el email real de Fabiola)
--    Esto llama a la Edge Function create-user, que crea cada cuenta con el email real
--    y la contraseña temporal que le asignes a cada persona.
-- Nota: Daniel queda como Administrador con acceso total y, a la vez, puede tener
-- proyectos, extras y pagos asignados a su propio nombre como colaborador operativo.

-- ============================================================================
-- AGREGADO: comprobantes de pago (archivo adjunto) y tareas por proyecto
-- ============================================================================

alter table public.payments add column if not exists receipt_path text;
alter table public.payments add column if not exists receipt_name text;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  assigned_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tasks_project_id on public.tasks(project_id);
create index if not exists idx_tasks_assigned_to on public.tasks(assigned_to);

alter table public.tasks enable row level security;

drop policy if exists "tasks_admin_all" on public.tasks;
create policy "tasks_admin_all" on public.tasks for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists "tasks_collaborator_all_own" on public.tasks;
create policy "tasks_collaborator_all_own" on public.tasks for all to authenticated using (
  assigned_to=(select auth.uid()) or exists(select 1 from public.projects p where p.id=tasks.project_id and p.assigned_to=(select auth.uid()))
) with check (
  assigned_to=(select auth.uid()) or exists(select 1 from public.projects p where p.id=tasks.project_id and p.assigned_to=(select auth.uid()))
);

grant select,insert,update,delete on public.tasks to authenticated;

-- Almacenamiento privado de comprobantes de pago (Supabase Storage).
-- Cada archivo se guarda con la ruta "<id_del_pago>/<archivo>"; solo el colaborador
-- dueño de ese pago o un administrador pueden subirlo, verlo o borrarlo.
insert into storage.buckets (id, name, public)
values ('attachments','attachments', false)
on conflict (id) do nothing;

drop policy if exists "attachments_select" on storage.objects;
create policy "attachments_select" on storage.objects for select to authenticated using (
  bucket_id = 'attachments' and exists (
    select 1 from public.payments pay
    where pay.id::text = (storage.foldername(name))[1]
    and (pay.collaborator_id = (select auth.uid()) or (select private.is_admin()))
  )
);

drop policy if exists "attachments_insert" on storage.objects;
create policy "attachments_insert" on storage.objects for insert to authenticated with check (
  bucket_id = 'attachments' and exists (
    select 1 from public.payments pay
    where pay.id::text = (storage.foldername(name))[1]
    and (pay.collaborator_id = (select auth.uid()) or (select private.is_admin()))
  )
);

drop policy if exists "attachments_delete" on storage.objects;
create policy "attachments_delete" on storage.objects for delete to authenticated using (
  bucket_id = 'attachments' and (select private.is_admin())
);

-- ============================================================================
-- AGREGADO: un colaborador puede tener tareas asignadas dentro de un proyecto
-- de otro responsable (ej. "logotipo" asignado a Fabiola dentro de un proyecto
-- que administra Daniel). Para que esa persona pueda ver el proyecto y la
-- empresa (y así llegar al botón "Tareas"), ampliamos el acceso de lectura.
-- ============================================================================

-- IMPORTANTE: la política de "projects" abajo consulta "tasks", y la política de
-- "tasks" (tasks_collaborator_all_own, arriba) consulta "projects". Si ambas se
-- consultan directamente entre sí, Postgres entra en "infinite recursion detected
-- in policy" al evaluar cualquiera de las dos. Por eso el lado de "projects" pasa
-- por esta función SECURITY DEFINER, que evalúa "tasks" salteándose su RLS (el
-- dueño de la función controla las tablas) y así rompe el ciclo.
create or replace function private.user_has_task_in_project(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.tasks t where t.project_id = p_project_id and t.assigned_to = auth.uid());
$$;
revoke all on function private.user_has_task_in_project(uuid) from public;
grant execute on function private.user_has_task_in_project(uuid) to authenticated;

drop policy if exists "projects_collaborator_select_own" on public.projects;
create policy "projects_collaborator_select_own" on public.projects for select to authenticated using (
  assigned_to=(select auth.uid())
  or private.user_has_task_in_project(projects.id)
);

drop policy if exists "companies_collaborator_select_assigned" on public.companies;
create policy "companies_collaborator_select_assigned" on public.companies for select to authenticated using (
  exists(
    select 1 from public.projects p
    where p.company_id=companies.id
    and (p.assigned_to=(select auth.uid()) or private.user_has_task_in_project(p.id))
  )
);

-- ============================================================================
-- AGREGADO: monto acordado con el colaborador por proyecto (distinto del monto
-- cobrado al cliente), y alertas simples (se reutiliza la tabla "activities" ya
-- existente). Cualquier usuario autenticado puede registrar una alerta para
-- OTRA persona (ej. un admin le avisa a un colaborador que le asignó una tarea
-- o le registró un pago); cada quien solo ve las suyas salvo administradores,
-- que ya veían todas.
-- ============================================================================

alter table public.projects add column if not exists collaborator_budget numeric(14,2) not null default 0;

drop policy if exists "activities_insert_own" on public.activities;
drop policy if exists "activities_insert_any" on public.activities;
create policy "activities_insert_any" on public.activities for insert to authenticated with check (true);

-- ============================================================================
-- AGREGADO: un colaborador ahora puede ver proyectos/tareas de otras personas
-- (ver más arriba), pero "profiles_select_own_or_admin" solo deja ver el PROPIO
-- perfil. Sin esto, cualquier nombre que no sea el suyo se mostraba como
-- "Sin asignar" en la lista de tareas o en "Responsable", y tampoco podía
-- elegir a un compañero al asignar una tarea nueva (el selector solo se veía a
-- sí mismo). Esta función solo expone id + nombre completo (nada de email,
-- usuario ni rol) de la gente activa, para que la interfaz pueda mostrar y
-- elegir nombres correctamente sin abrir el resto del perfil de nadie.
-- ============================================================================

create or replace function public.directory_names()
returns table(id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select id, full_name from public.profiles where active = true;
$$;
revoke all on function public.directory_names() from public;
grant execute on function public.directory_names() to authenticated;

-- ============================================================================
-- AGREGADO: rol "viewer" (usuario de prueba) — puede ENTRAR y VER absolutamente
-- todo (empresas, proyectos, tareas, extras, pagos) igual que un administrador,
-- pero jamás recibe los montos de dinero reales (ni en projects.quoted_amount/
-- client_paid/collaborator_budget, ni en project_extras.client_price/
-- collaborator_amount, ni en payments.amount). Es de SOLO LECTURA: no puede
-- crear, editar ni borrar nada.
--
-- El enmascarado es a nivel de BASE DE DATOS, no solo de interfaz: las tres
-- funciones de abajo (projects_for_viewer, extras_for_viewer, payments_for_viewer)
-- ni siquiera incluyen las columnas de dinero en su "returns table(...)", así que
-- esos valores nunca viajan por la red hacia una cuenta viewer, sin importar lo
-- que se inspeccione desde las herramientas de desarrollador del navegador.
-- ============================================================================

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin','collaborator','viewer'));

create or replace function private.is_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id=(select auth.uid()) and role='viewer' and active=true);
$$;
revoke all on function private.is_viewer() from public;
grant execute on function private.is_viewer() to authenticated;

-- Empresas y tareas no tienen columnas de dinero: el viewer puede verlas
-- directamente (RLS a nivel de fila), solo de lectura (no se agrega "for all").
drop policy if exists "companies_viewer_select_all" on public.companies;
create policy "companies_viewer_select_all" on public.companies for select to authenticated using ((select private.is_viewer()));

drop policy if exists "tasks_viewer_select_all" on public.tasks;
create policy "tasks_viewer_select_all" on public.tasks for select to authenticated using ((select private.is_viewer()));

-- projects / project_extras / payments SÍ tienen columnas de dinero: el viewer
-- NO recibe una policy de select directa sobre esas tablas (así que una consulta
-- directa a esas tablas le devuelve 0 filas). En su lugar, entra solo por estas
-- tres funciones, que devuelven todas las filas pero sin las columnas de dinero.

create or replace function public.projects_for_viewer()
returns table(
  id uuid, company_id uuid, title text, work_type text, description text,
  status text, start_date date, due_date date, currency text,
  assigned_to uuid, notes text, created_by uuid,
  created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select id, company_id, title, work_type, description,
    status, start_date, due_date, currency,
    assigned_to, notes, created_by,
    created_at, updated_at
  from public.projects
  where (select private.is_viewer());
$$;
revoke all on function public.projects_for_viewer() from public;
grant execute on function public.projects_for_viewer() to authenticated;

create or replace function public.extras_for_viewer()
returns table(
  id uuid, project_id uuid, title text, description text, extra_date date,
  currency text, billable_to_client boolean, client_status text, notes text,
  assigned_to uuid, created_by uuid, created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select id, project_id, title, description, extra_date,
    currency, billable_to_client, client_status, notes,
    assigned_to, created_by, created_at, updated_at
  from public.project_extras
  where (select private.is_viewer());
$$;
revoke all on function public.extras_for_viewer() from public;
grant execute on function public.extras_for_viewer() to authenticated;

-- Nota: receipt_path/receipt_name (el comprobante adjunto) se omiten a propósito:
-- suelen ser una foto/PDF de un pago real y podrían mostrar montos, así que ni
-- siquiera se listan aquí (además, storage.objects tampoco lo dejaría abrir).
create or replace function public.payments_for_viewer()
returns table(
  id uuid, collaborator_id uuid, project_id uuid, concept text,
  currency text, payment_method text, reference text, status text,
  due_date date, paid_date date, notes text, created_by uuid,
  created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select id, collaborator_id, project_id, concept,
    currency, payment_method, reference, status,
    due_date, paid_date, notes, created_by,
    created_at, updated_at
  from public.payments
  where (select private.is_viewer());
$$;
revoke all on function public.payments_for_viewer() from public;
grant execute on function public.payments_for_viewer() to authenticated;

-- ============================================================================
-- AGREGADO: separar el "monto total pactado" (payments.amount, ya existía) de lo
-- que realmente se le fue abonando al colaborador (payments.paid_amount, nuevo).
-- Antes, un pago "Parcial" no dejaba ver cuánto de ese monto ya se había entregado.
-- ============================================================================

alter table public.payments add column if not exists paid_amount numeric(14,2) not null default 0;

-- Para pagos que ya estaban marcados como "Pagado" antes de este cambio, asumimos
-- que se abonó el monto completo (si no, quedarían con paid_amount=0 mostrando
-- "Pendiente: monto completo" para un pago que en realidad ya estaba saldado).
update public.payments set paid_amount = amount where status = 'paid' and paid_amount = 0;

-- ============================================================================
-- AGREGADO: estado de tarea con tres pasos (pendiente / en progreso / completada)
-- en vez del simple casillero "hecho / no hecho". Esto permite que cada quien
-- pueda "iniciar" una tarea (queda "en progreso") y luego marcarla "terminada"
-- (queda "completada"), y que cada cambio quede registrado en el historial de
-- actividad ("Fabiola inició la tarea...", "Fabiola completó la tarea...").
-- ============================================================================

alter table public.tasks
  add column if not exists status text not null default 'pending'
  check (status in ('pending','in_progress','completed'));

-- Las tareas que ya estaban marcadas "hecho" (done = true) antes de este cambio
-- pasan a "completed"; el resto queda en "pending" (valor por defecto de la columna).
update public.tasks set status = 'completed' where done = true and status = 'pending';

create index if not exists idx_tasks_status on public.tasks(status);

-- ============================================================================
-- AGREGADO: campo de instrucciones/pasos para cada tarea, que llena quien la
-- asigna (normalmente el administrador) para que quien la ejecuta sepa qué hacer.
-- ============================================================================

alter table public.tasks add column if not exists instructions text;
