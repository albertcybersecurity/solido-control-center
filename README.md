# Sólido Control Center — versión real

Aplicación privada para **Sólido Business Group** con base de datos Supabase, inicio de sesión seguro y acceso separado por usuario. No contiene cuentas de demostración, no guarda información sensible solo en el navegador, y no expone la `service role key`.

## Usuarios previstos

- `daniel.perez` — **Daniel Pérez — Administrator** (además tiene proyectos, extras y pagos propios como colaborador)
- `yini.puleo` — **Yini Puleo — Administrator**
- `alonso.rivera` — **Alonso Rivera — Administrator**
- `fabiola.dominguez` — **Fabiola Dominguez — Collaborator** (acceso privado, solo ve lo suyo)

Los administradores (Daniel, Yini y Alonso) ven y administran absolutamente todo: empresas, proyectos, colaboradores, montos, extras, pagos, estados, usuarios, contraseñas temporales, reportes y respaldos. Fabiola solo puede ver sus propios proyectos asignados, tareas, extras, pagos y fechas — nunca los de otro colaborador.

## Paso 1 — Crear el proyecto Supabase

1. Entra a [supabase.com](https://supabase.com) y crea un proyecto nuevo (elige una contraseña de base de datos fuerte y guárdala en un lugar seguro, no la necesitarás para la app).
2. En **SQL Editor**, pega y ejecuta **todo** el contenido de `supabase/schema.sql`. Esto crea las tablas, los estados de proyecto, las políticas de seguridad (RLS) y la función de login por usuario.
3. En **Authentication → Providers**, deja únicamente **Email** habilitado y desactiva **"Allow new users to sign up"** (el registro público), porque las cuentas solo se crean desde el panel de administración.
4. En **Authentication → URL Configuration**, agrega la URL donde publiques la app (ver Paso 4) como **Site URL** y también como **Redirect URL** — esto es necesario para que el enlace de "recuperar contraseña" funcione.

## Paso 2 — Crear tu propia cuenta (Daniel) como primer administrador

Como quien configura el sistema, creas tu propia cuenta directamente en Supabase:

1. En **Authentication → Users → Add user**, crea el usuario con tu email real `daniel.perez@solidobusiness.com` y una contraseña que elijas tú mismo (marca "Auto Confirm User").
2. En **SQL Editor**, ejecuta (ya viene comentado al final de `schema.sql`):

```sql
update public.profiles set username='daniel.perez', full_name='Daniel Pérez', role='admin', job_title_en='Web Developer & Graphic Designer / Administrator', active=true where id=(select id from auth.users where email='daniel.perez@solidobusiness.com');
```

## Paso 3 — Copiar las claves y desplegar las Edge Functions

1. En **Project Settings → API**, copia el **Project URL** y la **anon/public key**, y pégalas en `assets/config.js`. **Nunca** copies ni publiques la `service_role key` — las funciones que la usan corren del lado del servidor (Edge Functions), no en el navegador.
2. Instala el CLI de Supabase y despliega las dos funciones (se ejecutan con la service role key de forma segura en el servidor, nunca en el navegador):

```bash
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase functions deploy create-user
supabase functions deploy reset-user-password
```

No hace falta ninguna variable adicional: las funciones ya reciben `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` automáticamente de tu proyecto Supabase.

## Paso 4 — Publicar en GitHub Pages

1. Crea un repositorio **privado** en tu propia cuenta de GitHub, por ejemplo `solido-control-center`.
2. Sube todo el contenido de esta carpeta a la rama `main`.
3. En **Settings → Pages** del repositorio, en "Build and deployment" elige **Source: GitHub Actions** (el workflow ya está incluido en `.github/workflows/pages.yml` y se ejecuta automáticamente en cada push).
4. La URL quedará como `https://TU-USUARIO.github.io/solido-control-center/` (GitHub Pages en un repo privado requiere un plan GitHub Pro/Team/Enterprise, o puedes hacer el repo público si el contenido del código no es sensible — recuerda que las credenciales reales viven en Supabase, no en este repositorio).
5. Vuelve al Paso 1.4 en Supabase y confirma que esta URL final esté cargada como **Site URL** y **Redirect URL**.

## Paso 5 — Crear a Yini, Alonso y Fabiola desde el panel

1. Entra a la app publicada con tu usuario `daniel.perez`.
2. Ve a **Usuarios y permisos → Crear usuario** y da de alta a cada persona con su **email real** de trabajo, el cargo, el permiso (Administrator para Yini y Alonso, Collaborator para Fabiola) y una contraseña temporal segura.
3. Comparte la contraseña temporal de cada persona por un canal privado y seguro (no por este repositorio ni por chat público). Cada quien debe cambiarla desde **Mi cuenta → Cambiar contraseña** en su primer ingreso.

## Recuperación de contraseña

Cualquier usuario puede tocar **"¿Olvidaste tu contraseña?"** en la pantalla de acceso, escribir su nombre de usuario, y recibirá un enlace de un solo uso en su correo real registrado para definir una nueva contraseña. Por defecto Supabase envía estos correos con su servicio integrado (válido para uso interno de bajo volumen); si más adelante quieres correos con tu propio dominio y mejor entrega, puedes configurar un proveedor SMTP propio (por ejemplo Resend o Postmark) en **Authentication → Emails → SMTP Settings** de Supabase — es opcional y no bloquea el uso del sistema.

## Seguridad aplicada

- Daniel, Yini Puleo y Alonso Rivera son administradores: los tres pueden ver y administrar todas las empresas, proyectos, extras, pagos, usuarios y actividad.
- Fabiola es colaboradora: solo ve sus propios proyectos asignados, extras relacionados y pagos propios.
- Row Level Security está activo en todas las tablas; las políticas están definidas en `supabase/schema.sql`.
- Las operaciones administrativas de usuarios (crear cuentas, resetear contraseñas) corren en Edge Functions del lado del servidor, nunca en el navegador, y la `service_role key` nunca se publica en el repositorio ni en `config.js`.
- El inicio de sesión usa un nombre de usuario simple (ej. `daniel.perez`) que se traduce internamente al email real de la persona mediante una función seleccionable solo por su nombre (`email_for_username`), sin exponer ningún otro dato.
- No existe modo demo ni almacenamiento local de datos empresariales; la sesión se mantiene mediante Supabase Auth, y los datos persisten en la base de datos después de cerrar sesión.
- El diseño es responsivo: funciona desde computadora y celular (menú lateral colapsable en pantallas pequeñas).

## Checklist antes de anunciar el sistema como "en vivo"

- [ ] Daniel, Yini y Alonso pueden iniciar sesión y ven todas las empresas, proyectos, extras y pagos.
- [ ] Fabiola inicia sesión y **solo** ve sus propios registros (verifícalo creando un proyecto de prueba asignado a otro colaborador y confirmando que ella no lo ve).
- [ ] Ninguna contraseña aparece en el código, en `config.js` ni en este repositorio.
- [ ] Cerrar sesión y volver a entrar conserva los datos (persistencia real en Supabase, no en LocalStorage).
- [ ] El "olvidé mi contraseña" entrega el correo de recuperación y permite definir una nueva contraseña.
- [ ] La app se ve y funciona bien tanto en computadora como en el celular.
