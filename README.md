# AI Meeting to Action

**Team name:** Phantom
**Team members:** Aaryan Sharma, R Sudharsan, Koushik Dinesh, Ahmad Irfan, Keerthan Vinay
Koushik Dinesh - Frontend and Backend, Aaryan Sharma - Frontend , R Sudharsan - Testing
Turns meeting transcripts into reviewed, assigned action items.

Upload or capture a meeting transcript, let an AI model propose action items with evidence from the transcript, review and approve them as an admin, then email each person their items and track progress in a personal task portal.

> **Status: v1 prototype.** It runs end to end on a developer machine. It is not deployed, has not been security-reviewed for production, and some integrations (the meeting bot, real email) are only partly verified. See [Known limitations](#known-limitations).

---

## Table of contents

- [What it does today](#what-it-does-today)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Setup: Windows](#setup-windows)
- [Setup: macOS](#setup-macos)
- [Running the app](#running-the-app)
- [Optional: AI extraction](#optional-ai-extraction)
- [Optional: email notifications](#optional-email-notifications)
- [Optional: Vexa meeting bot](#optional-vexa-meeting-bot)
- [Using the app](#using-the-app)
- [Running the tests](#running-the-tests)
- [API overview](#api-overview)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap (after v1)](#roadmap-after-v1)

---

## What it does today

### 1. Accounts and roles
- Email and password sign-in. The session is stored in an `httpOnly`, `SameSite=Lax` cookie and backed by a server-side session row, so **logout revokes it** immediately.
- **Invitations**: an admin adds a person and emails them a one-time link (expires after `INVITATION_TTL_HOURS`, default 72 h). They choose their own password; no password is ever emailed.
- Three roles:
  - **Admin**: manages users and meetings, reviews action items, sends emails, manages every project and team.
  - **Manager**: creates projects and teams and manages the ones they own or lead; sees their own tasks.
  - **Employee**: sees their own tasks and the projects and teams they belong to (read-only).
- Users can have **aliases** (alternative names or spellings) so that a name in a transcript maps to the right person.
- Every request re-reads the user from the database, so deactivating a user or changing a role takes effect immediately. Deactivation also revokes all of the person's sessions and open invitations.

### Projects and teams
- **Projects** have a name, description, status (planning, active, on hold, completed, archived), owner, members and optional start/target dates. Archived projects are read-only.
- A **meeting** can optionally belong to a project (chosen manually by an admin). Its action items follow the meeting's project; the project page lists its meetings, tasks (with review status and task status kept separate) and activity.
- **Teams** are simple groups with an optional lead; a whole team can be added to a project at once.
- Leaving a project or being deactivated never deletes tasks, meetings or audit history.

### 2. Meetings and transcripts
- Create a meeting and attach a transcript by **manual upload**. This always works.
- Optional: import a transcript from the **Vexa meeting bot** (see [Optional: Vexa meeting bot](#optional-vexa-meeting-bot)). Speakers, timestamps and languages are kept.
- An existing transcript is never overwritten automatically.

### 3. AI action-item extraction (optional)
- A background **worker** reads a meeting's transcript and proposes action items.
- Every saved item carries **evidence**: a quote that is checked against the stored transcript segments.
- Items with ownership or deadline problems are kept but **flagged**, with a description of the problem.
- Deadlines are resolved relative to a configured timezone (for example, "tomorrow" or "Friday").
- Re-running extraction replaces only the meeting's pending AI items. Items that were approved or rejected are never touched.
- Uses the Claude API. The model is configurable (`ANTHROPIC_MODEL`). The worker checks the model on startup.

### 4. Admin review
- Admins approve, edit or reject each proposed item.
- Meeting status moves through: `transcript_ready` → `extracting` → `review_pending` → `approved`, or `failed` (with a `last_error` message).

### 5. Email notifications
- After a review is finished (meeting status `approved`), the meeting page shows an **Email notifications** panel.
- Admins see a preview of who gets which approved items, then click **Send** (with a confirmation step).
- Each recipient receives **one email per meeting** containing only their own approved items.
- Nothing is ever sent automatically. Per-recipient status is shown, and failed sends can be retried.
- Sent emails are never resent. Repeated clicks do not create duplicates (idempotency keys).
- Supported providers: SMTP (for example Mailpit locally, or a real SMTP server) and Resend.

### 6. Employee task portal
- Employees sign in and land on **My tasks**.
- Summary counts: total, not started, in progress, completed, overdue.
- Filters for status, priority, overdue and search. Sorting by due date and other fields.
- Each task has a detail page with the meeting context, the supporting transcript excerpt, and a history of changes.
- Employees can move their own tasks between **Not started**, **In progress**, **Blocked** and **Completed** (and reopen them).
- Employees can see only tasks assigned to them, from meetings whose review is finished. Anything else returns "not found".
- Status changes do not send email. Admins see progress in each meeting's action items.

---

## How it works

```
 Browser (React)  ──►  API (Express, :4000)  ──►  MySQL 8.4 (:3307)
                              ▲   │
                              │   └──► Mailpit / SMTP / Resend   (email)
                              │
                       Worker (background jobs)
                         ├── ai.extract   → Claude API
                         ├── email.send   → SMTP / Resend
                         └── vexa.poll    → Vexa gateway (optional)
```

- The **API** handles requests. It never calls the AI model or sends email directly. It queues a job in MySQL.
- The **worker** picks up jobs from the database, retries temporary failures with exponential backoff, and marks jobs that stall (for example, if the worker dies mid-send) so they are not silently duplicated.
- All database access is plain SQL with migrations. There is no ORM.

---

## Tech stack

| Part | Technology |
|---|---|
| Backend | Node.js 22, Express 5, mysql2 (plain SQL), JWT in an httpOnly cookie, bcrypt, zod validation |
| Frontend | React 19, Vite, React Router, Tailwind CSS 4 (via `@tailwindcss/vite`) |
| Database | MySQL 8.4 |
| Local services | Docker Compose: MySQL and Mailpit |
| AI | Anthropic Claude API (configurable model) |
| Email | SMTP (Mailpit locally) or Resend |
| Meeting bot | Vexa (optional, separate project) |

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **22** (see `.nvmrc`) | Backend and frontend |
| npm | comes with Node | Installing packages |
| Docker | Docker Desktop (Windows, macOS), or OrbStack or Colima (macOS) | MySQL and Mailpit |
| Git | any recent | Cloning the repo (optional if you have the folder) |
| Anthropic API key | optional | AI extraction only |
| Vexa | optional | Meeting bot only |

---

## Setup: Windows

These steps were tested on Windows 11 Home.

### 1. Turn on WSL 2 and Docker Desktop

1. Open **PowerShell as Administrator** and run:
   ```powershell
   wsl --install
   ```
   Restart the PC when asked. If WSL is already installed, run `wsl --update` instead.
2. Enable the Virtual Machine Platform feature if Docker complains about virtualization:
   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
   ```
   Restart again if it asks. If Docker still reports a virtualization error, enable **Intel VT-x** or **AMD SVM** in the BIOS.
3. Install **Docker Desktop** from docker.com. Keep "Use WSL 2 based engine" ticked.
4. Open Docker Desktop and wait until it says **Engine running**.
5. Check that Docker works:
   ```powershell
   docker run hello-world
   ```

### 2. Install Node.js 22 with nvm-windows

1. Download `nvm-setup.exe` from https://github.com/coreybutler/nvm-windows/releases and install it with the default options.
2. If you already have Node.js installed from nodejs.org, uninstall it from **Settings → Apps → Installed apps** so it doesn't conflict with nvm.
3. Close all PowerShell windows and open a new one:
   ```powershell
   nvm install 22
   nvm use 22
   node -v
   ```
   `node -v` must print `v22.x`.

If PowerShell refuses to run `npm` scripts, allow local scripts once:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 3. Get the project

Unzip the project. If the unzip created **two folders with the same name**, use the **inner** one, the folder that contains `README.md`, `backend/`, `frontend/` and `docker-compose.yml`. Ignore any `__MACOSX` folder and files starting with `._` or `.DS_Store`. These are leftovers from macOS zipping and are not part of the project.

---

## Setup: macOS

1. Install **Docker Desktop**, **OrbStack** or **Colima**, and start it.
2. Install Node 22 with nvm:
   ```bash
   nvm install
   nvm use
   ```
   The `nvm use` command reads `.nvmrc`.

---

## Running the app

The first start takes a few minutes while images download and dependencies install.

All commands below are run **from the project folder** (the one that contains `docker-compose.yml`), unless a step says otherwise.

### Step 1: Configure environment files

Two `.env` files are needed.

**Root `.env`** (read by Docker Compose only):

```bash
cp .env.example .env
```

On Windows PowerShell use `Copy-Item .env.example .env`. Then set real passwords:

```
MYSQL_ROOT_PASSWORD=<choose a password>
MYSQL_DATABASE=meeting_action
MYSQL_USER=meeting_action
MYSQL_PASSWORD=<choose a password>
MYSQL_TEST_DATABASE=meeting_action_test
```

**Backend `.env`** (read by the API and worker):

```bash
cp backend/.env.example backend/.env
```

Set these values:

| Variable | What to put |
|---|---|
| `DB_PASSWORD` | **Must equal** `MYSQL_PASSWORD` from the root `.env` |
| `JWT_SECRET` | A random string of at least 32 characters (see below) |
| `SEED_ADMIN_EMAIL` | Email for the first admin account |
| `SEED_ADMIN_PASSWORD` | Admin password, at least 12 characters |
| `SEED_EMPLOYEE_EMAIL` | Optional. Email for a test employee account |
| `SEED_EMPLOYEE_PASSWORD` | Employee password, at least 12 characters |
| `SEED_MANAGER_EMAIL` / `SEED_MANAGER_PASSWORD` | Optional. A test manager account |
| `INVITATION_TTL_HOURS` | Optional. Invitation link lifetime in hours (default 72). Invitations also need `EMAIL_PROVIDER`, `EMAIL_FROM` and `APP_PUBLIC_URL` |

Generate `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> **Important:** `DB_PASSWORD` and `MYSQL_PASSWORD` must match exactly. If they differ, the API and worker cannot log in to MySQL ("Access denied for user 'meeting_action'").

> **Important:** The MySQL container sets its password **only the first time it creates its data volume**. If you change `MYSQL_PASSWORD` later, run `docker compose down -v` to reset the database. This deletes all local data.

### Step 2: Start MySQL and Mailpit

```bash
docker compose up -d
docker compose ps
```

Wait until `mysql` shows `healthy`.

| Service | Address |
|---|---|
| MySQL | `127.0.0.1:3307` |
| Mailpit web UI | http://localhost:8025 |
| Mailpit SMTP | `127.0.0.1:1025` |

### Step 3: Install, migrate and seed the backend

```bash
cd backend
npm install
npm run migrate
npm run seed
```

- `migrate` creates the tables.
- `seed` creates the admin (and employee, if configured). It skips users that already exist and refuses to run with `NODE_ENV=production`.

### Step 4: Install the frontend

```bash
cd ../frontend
npm install
```

### Step 5: Start the app

Use **two terminal windows**.

**Window 1, API:**
```bash
cd backend
npm run dev
```
Wait for `api listening` (port 4000).

**Window 2, web app:**
```bash
cd frontend
npm run dev
```
The app is at http://localhost:5173. It forwards `/api` requests to port 4000.

Open **http://localhost:5173** and sign in:
- Admin → `/admin`
- Employee → `/my/tasks`

### Optional Window 3: background worker

Only needed for AI extraction and email sending. See the sections below.

```bash
cd backend
npm run worker
```

Use `npm run worker:dev` to restart automatically when files change.

### Stopping

- Press `Ctrl+C` in each window.
- To stop the database and mail containers but keep data: `docker compose stop`
- To remove the containers but keep data: `docker compose down`
- To delete everything, including data: `docker compose down -v`

---

## Optional: AI extraction

1. Get an API key from the Anthropic console.
2. In `backend/.env`, set:
   ```
   ANTHROPIC_API_KEY=<your key>
   ANTHROPIC_MODEL=claude-opus-5-5
   MEETING_TIMEZONE=<IANA timezone, for example Asia/Kolkata or Europe/London>
   ```
   `ANTHROPIC_MODEL` can also be `claude-haiku-5-5`. Haiku is faster and cheaper, but extraction may be less accurate.
3. Run the migration again and restart the API:
   ```bash
   cd backend
   npm run migrate
   ```
4. Start the worker (Window 3 above).
5. Open a meeting that has a transcript, and start extraction from the meeting page. The meeting moves to `extracting`, then `review_pending`.

API alternative (you need a session cookie from `/auth/login` first):
```bash
curl -b cookies.txt -X POST http://localhost:4000/api/v1/meetings/<id>/extract
curl -b cookies.txt http://localhost:4000/api/v1/meetings/<id>/action-items
```

---

## Optional: email notifications

For local testing, use Mailpit (already in `docker-compose.yml`). In `backend/.env`:

```
EMAIL_PROVIDER=smtp
EMAIL_FROM="Meeting to Action <no-reply@example.test>"
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
APP_PUBLIC_URL=http://localhost:5173
```

Leave `SMTP_USER` and `SMTP_PASS` empty for Mailpit. Restart the API and worker, then view sent emails at http://localhost:8025.

For real sending:
- **SMTP:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE=true` for port 465.
- **Resend:** set `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`. Recipients other than your own address require a verified sending domain.

"Sent" means the mail server or Resend accepted the message. It does not prove the message reached an inbox.

---

## Optional: Vexa meeting bot

Vexa is a separate open-source project. It runs in its own Docker Compose stack and is **not part of this repo**. This app only calls its REST API from the backend. If Vexa isn't set up, the app still works, and you upload transcripts by hand.

### Set up Vexa (Ubuntu / WSL on Windows, or macOS terminal)

On Windows, do this inside the Ubuntu (WSL) window. First, enable Docker Desktop's WSL integration: **Docker Desktop → Settings → Resources → WSL Integration**, turn on your Ubuntu distro, then click **Apply & Restart**.

```bash
sudo apt update && sudo apt install -y make git
git clone https://github.com/Vexa-ai/vexa.git
cd vexa
make all
```

`make all` pulls images and prints an API key that starts with `vxa_`, along with the service URLs. It needs Docker 26 or newer.

> **If `make all` says "permission denied" on the Docker socket** (Linux or WSL): run `sudo usermod -aG docker $USER`, then run `wsl --shutdown` from Windows PowerShell and reopen Ubuntu.

Vexa also needs a **transcription service** to produce transcripts. Create a `vxa_tx_` key on your Vexa account (https://vexa.ai/account, **Transcription** → **API Keys**). Then put the transcription URL and token into Vexa's settings. Vexa's error message names the two variables: `TRANSCRIPTION_SERVICE_URL` and `TRANSCRIPTION_SERVICE_TOKEN`. Restart Vexa with `make down` and then `make all`.

Vexa's web UI runs at http://localhost:13000. The first person to sign in there becomes the Vexa admin. Vexa is in test mode until OAuth is configured, so the admin email must contain the word "test".

### Connect this app to Vexa

In `backend/.env`:

```
VEXA_BASE_URL=http://localhost:18056
VEXA_API_KEY=<the vxa_ key printed by make all>
```

Restart the API and worker. On a meeting with a Google Meet link (`https://meet.google.com/abc-defg-hij`), the **Meeting bot** panel can send the bot, show its state (joining, waiting in the lobby, in the meeting, ended, failed) and stop it. Admit the bot from the Meet lobby. When the meeting ends, the transcript is imported automatically.

Alternative: Vexa's hosted service is at `https://api.cloud.vexa.ai`. Use your key from vexa.ai/account and set `VEXA_BASE_URL` to that address. You skip running Vexa locally.

---

## Using the app

### Admin
1. Sign in as the admin. You land on `/admin`.
2. On **Users**, add people and email them an invitation (locally it arrives in Mailpit at http://localhost:8025). Resend or revoke it from the same page.
3. On **Projects**, create a project, pick its owner and add members (or a whole team from **Teams**).
4. Create a meeting (optionally in a project), then upload a transcript or import one from Vexa.
5. Start AI extraction (if configured) and wait for `review_pending`.
6. Review each item: approve, edit or reject. Flagged items need attention.
7. When review is finished, the meeting becomes `approved`. Open **Email notifications**, check the preview, and click **Send**.
8. Watch progress in the meeting's action items or on the project page.

### Manager
1. Sign in (after accepting an invitation). You land on **Projects**.
2. Create projects and teams; you own and lead them. Edit details, change status, archive, and manage members.
3. Your own assigned tasks are under **My tasks**.

### Employee
1. Open the invitation link from your email, choose a password, then sign in. You land on **My tasks** (`/my/tasks`).
2. Filter, search and sort your tasks. Overdue tasks are highlighted.
3. Open a task to see the meeting context and the supporting transcript excerpt.
4. Change a task's status as work progresses.

---

## Running the tests

The tests use a separate database (`DB_TEST_NAME`) and **delete all data in it**. They never touch `DB_NAME`. Claude is mocked during tests, so no paid API calls are made.

```bash
cd backend
npm test
```

The test runner migrates the test database automatically and wipes it; to leave it alone, set `DB_TEST_NAME` to a throwaway database (see `docs/runbooks/database-migrations.md`). You can migrate it manually with `NODE_ENV=test npm run migrate`.

---

## API overview

All routes are under `/api/v1`. Errors have the shape `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | public | Returns 503 if the database is unreachable |
| POST | `/auth/login` | public | Body `{ email, password }`. Sets the session cookie. Limited to 10 attempts per IP and email per 15 minutes |
| POST | `/auth/logout` | signed in | Revokes the server-side session and clears the cookie |
| POST | `/auth/invitations/verify` | public | Body `{ token }`. Who the invitation is for. Rate limited per IP |
| POST | `/auth/invitations/accept` | public | Body `{ token, password }`. Sets the password (single use). Rate limited per IP |
| GET | `/auth/me` | signed in | Current user |
| GET/POST | `/users/:id/invitations` | admin | List / send (or resend) an invitation email |
| POST | `/users/:id/invitations/revoke` | admin | Revoke the open invitation |
| GET/POST | `/projects` | signed in | List visible projects / create (admin, manager) |
| GET/PATCH | `/projects/:id` | member / owner, admin | Details / edit, status, archive (owner or admin; owner change admin only) |
| GET/POST/DELETE | `/projects/:id/members[/:userId]` | member / owner, admin | Membership (`{ userIds }` or `{ teamId }`) |
| GET | `/projects/:id/meetings`, `/tasks`, `/activity` | member | Tasks: everything for owner/admin, own tasks for others |
| GET/POST/PATCH | `/teams[/:id]` | signed in | Teams (create: admin, manager; edit: lead or admin) |
| POST/DELETE | `/teams/:id/members[/:userId]` | lead, admin | Team membership |
| GET | `/directory/users` | admin, manager | Active people for pickers |
| PUT | `/action-items/:id/project` | admin | Move one item to another project (any review state) |
| GET | `/me/tasks` | employee | Own tasks, with filters |
| GET | `/me/tasks/:id` | employee | One own task |
| PATCH | `/me/tasks/:id/status` | employee | Change status (`fromStatus` check rejects stale updates) |
| POST | `/meetings/:id/extract` | admin | Queue AI extraction (202) |
| GET | `/meetings/:id/action-items` | admin | Items, evidence, flags, run status |

Middleware: `requireAuth`, `requireRole('admin')`, `validate({ body: zodSchema })`.

---

## Project layout

```
backend/src/
  app.js, server.js       Express wiring and startup
  worker.js               background worker entry point
  config/                 environment loading and validation (zod)
  db/                     pool.js, migrate.js, migrations/*.sql, seeds/
  middleware/             auth, validate, rateLimit, errorHandler
  routes/ controllers/    HTTP layer
  services/ repositories/ business logic and SQL
  services/ai/            extraction prompt, validator (rules at the top of validator.js)
  utils/                  logger (JSON lines), errors
backend/test/             node:test and supertest integration tests
frontend/src/
  api/ auth/ components/ pages/{admin,employee}/ router.jsx
docker/mysql/init/        creates the test database on first start
docker-compose.yml        MySQL and Mailpit
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Access denied for user 'meeting_action'` | `DB_PASSWORD` doesn't match `MYSQL_PASSWORD`, or the volume was created with an older password | Make them match. If you changed the root password after first start, run `docker compose down -v` and start again (this deletes data) |
| `docker: command not found` in WSL | Docker Desktop WSL integration is off | Docker Desktop → Settings → Resources → WSL Integration → enable your distro → Apply & Restart |
| `permission denied ... docker.sock` | Your user isn't in the `docker` group | `sudo usermod -aG docker $USER`, then `wsl --shutdown` from PowerShell and reopen Ubuntu |
| `nvm` not recognised in PowerShell | Installer ran but the window wasn't reopened | Close all PowerShell windows and open a new one |
| `node -v` shows the wrong version | Old Node install is still present | Uninstall the old Node.js, then `nvm use 22` in a new window |
| API returns 503 on `/health` | Database not reachable | Check `docker compose ps` shows `mysql` as healthy |
| Worker logs `Access denied` every few seconds | Same as the first row | Fix the password mismatch and restart the worker |
| Bot says "Could not reach Vexa" | Vexa isn't running, or `VEXA_BASE_URL` is wrong | Start Vexa with `make all`, check `VEXA_BASE_URL=http://localhost:18056` |
| Bot says "no transcription backend configured" | Vexa has no transcription token | Add the transcription URL and token in Vexa's settings, restart Vexa |
| Extraction never starts | `ANTHROPIC_API_KEY` empty, or worker not running | Set the key and run `npm run worker` |
| Emails don't appear | Worker not running, or `EMAIL_PROVIDER` wrong | Run `npm run worker`, check `EMAIL_PROVIDER=smtp` and the Mailpit port |

---

## Known limitations

- **Prototype only.** Runs on a developer machine. Not deployed.
- **Sessions issued before Phase 2** (JWTs without a session id) are refused; everyone signs in again once after upgrading.
- **Rate limits are in-memory** (login, invitation endpoints): per API process, reset on restart.
- **Vexa bot is not verified end to end** against a real Google Meet call. It is built to Vexa's gateway API and tested with mocks.
- **AI extraction costs money** per run and depends on the configured model's behaviour. Output quality varies by model and transcript.
- **Email is local-only by default** (Mailpit). Real delivery needs SMTP or Resend credentials and, for Resend, a verified domain.
- **Seed accounts** use example emails and passwords from `backend/.env`. Change them before sharing the app.
- **Single-company by design.** Each customer gets its own deployment and database; there is no tenant separation inside one install.

---

## Roadmap (after v1)

- Deploy with production secrets, HTTPS and a real database host
- Verify the Vexa bot against live Google Meet calls
- Configure real email delivery and domain verification
- Broader testing with real meeting transcripts
- Multi-organisation support

---

## Documentation

- Planning, design decisions and roadmap: `docs/PLANNING.md`
- Security notes: see the **Security notes** section of the project's original README and `backend/src/services/ai/validator.js`
