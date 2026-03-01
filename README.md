# CA Comply — Windows Docker Deployment Guide

## ✅ You'll be running in under 5 minutes

---

## Prerequisites (one-time setup)

1. **Docker Desktop for Windows** must be installed and running
   - Download: https://www.docker.com/products/docker-desktop/
   - After install, open Docker Desktop and wait for the whale icon to stop animating

2. That's it. No Node.js, no PostgreSQL, no other installs needed.

---

## Step 1 — Extract This Folder

Extract the zip to any location, e.g.:
```
C:\ca-comply\
```

---

## Step 2 — Start the Application

**Option A (Easiest):** Double-click `START.bat`

**Option B (Command line):**
```cmd
cd C:\ca-comply
docker-compose up --build -d
```

First run downloads images — takes **2-3 minutes**.
Subsequent starts take **~15 seconds**.

---

## Step 3 — Open in Browser

```
http://localhost
```

**Demo Login Credentials:**
| Field    | Value                       |
|----------|-----------------------------|
| Email    | ravi@raviranjan-ca.in       |
| Password | Demo@1234                   |

**Other demo users (same password `Demo@1234`):**
| Email                        | Role    |
|------------------------------|---------|
| ravi@raviranjan-ca.in        | Partner |
| priya@raviranjan-ca.in       | Manager |
| amit@raviranjan-ca.in        | Staff   |
| sunita@raviranjan-ca.in      | Staff   |

---

## What's Running

| Service    | URL                           | Purpose                |
|------------|-------------------------------|------------------------|
| App (UI)   | http://localhost              | Main application       |
| API        | http://localhost:4000/api     | Backend REST API       |
| Health     | http://localhost:4000/api/health/ready | Status check |
| PostgreSQL | localhost:5432                | Database               |

---

## Features Included

- ✅ **Dashboard** — Real-time stats, upcoming deadlines, activity feed
- ✅ **Compliance** — Task management with overdue detection, mark done, assign
- ✅ **Clients** — Full client CRUD with compliance health view
- ✅ **Documents** — File upload (PDF, images, Excel), download
- ✅ **Work Allocation** — Team workload view, task assignment
- ✅ **Analytics** — Feature usage charts, error log, audit trail
- ✅ **Notifications** — In-app notification system
- ✅ **Settings** — Firm profile, user management
- ✅ **Multi-tenant** — Register new CA firms via the Register tab on login
- ✅ **RBAC** — Partner / Manager / Staff role permissions enforced

---

## Register a New CA Firm

1. Go to http://localhost
2. Click the **"Register Firm"** tab
3. Fill in firm details
4. A new isolated firm is created with its own users, clients, and data

---

## Useful Commands

```cmd
# Start app
docker-compose up -d

# Stop app (data preserved)
docker-compose down

# View live logs
docker-compose logs -f

# View API logs only
docker-compose logs -f api

# Restart just the API
docker-compose restart api

# Full reset (WARNING: deletes all data)
docker-compose down -v

# Check service status
docker-compose ps
```

---

## Database Access (optional)

Connect with any PostgreSQL client (e.g. DBeaver, pgAdmin, TablePlus):
```
Host:     localhost
Port:     5432
Database: ca_comply
Username: ca_comply_user
Password: Ca_Comply_Secure_Pass_2024!
```

---

## Troubleshooting

**"Port 80 already in use"**
```cmd
# Find what's using port 80
netstat -aon | findstr ":80"
# Then kill it by PID, or change port in docker-compose.yml:
# ports: - "8080:80"   ← use 8080 instead
# Then access: http://localhost:8080
```

**"Docker is not running"**
- Open Docker Desktop from Start Menu
- Wait for the whale icon to be steady (not animating)

**Blank page / API errors**
```cmd
docker-compose logs api
# Look for red error messages
```

**Reset everything (fresh start)**
```cmd
docker-compose down -v
docker-compose up --build -d
```

---

## Architecture

```
Browser
  ↓ :80
Nginx (frontend + reverse proxy)
  ↓ /api/* → :4000
Node.js API (Express)
  ↓
PostgreSQL :5432
```

All 3 containers run on the same Docker network and talk to each other by service name.
