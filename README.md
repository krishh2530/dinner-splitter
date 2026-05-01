# 🍽️ DinnerTab — Smart Dinner Bill Splitter

Split dinner bills across 20+ people without the chaos.

---

## 🚀 Quick Start (Local)

```bash
cd dinner-splitter
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

Share the link with your group on the **same WiFi network**:
```
http://<your-laptop-ip>:3000
```
Find your IP with: `ipconfig` (Windows) or `ifconfig`/`ip a` (Mac/Linux)

---

## 👑 Owner Account

Login name: **Krishna** (case-insensitive)

Owner can:
- See ALL orders from everyone in real-time
- Delete any order
- Remove users
- Set CGST, SGST, Service Charge, Discount
- Calculate everyone's final share automatically
- Reset the entire session

---

## 👤 Regular Users

- Login with just your name (no password needed)
- Place solo or group orders
- Accept/decline group invitations
- See your own order history and running total
- See your estimated final share once Krishna sets taxes

---

## 🔄 How Group Orders Work

1. Person A creates a Group order → selects who's sharing
2. Selected people get a real-time notification (🔔 bell badge)
3. They go to Notifications → Accept or Decline
4. Share is split only among accepted members
5. If someone declines, remaining members' share goes up

---

## 💰 Bill Calculation

Krishna enters:
- **CGST %** (e.g., 2.5)
- **SGST %** (e.g., 2.5)
- **Service Charge %** (e.g., 10)
- **Discount %** (e.g., 5)

The app:
1. Adds up everyone's base food total
2. Applies taxes and charges
3. Applies discount
4. Calculates each person's proportional final share

---

## 📁 File Structure

```
dinner-splitter/
├── server.js         — Node.js backend (Express + Socket.io)
├── data.json         — Auto-created: your dinner data (delete to reset)
├── package.json
└── public/
    └── index.html    — Complete frontend (single file)
```

---

## 🌐 Deploy to the Internet (Optional)

### Option A: Railway (Easiest, free)
1. Push to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Done! Share the URL

### Option B: Render (Free)
1. Push to GitHub
2. render.com → New Web Service → Connect repo
3. Build: `npm install` | Start: `node server.js`

### Option C: Fly.io
```bash
npm install -g flyctl
fly launch
fly deploy
```

---

## 🛑 Reset

Owner can reset from the **Manage** tab → "Reset Everything"
Or just delete `data.json` and restart the server.
