# Pick What We Watch

A lightweight family movie and TV voting app. Requires Node.js 22 or newer.

## Windows setup

1. Copy `.env.example` to `.env` and set a private `ADMIN_PIN` and `SESSION_SECRET`.
2. In PowerShell, from this folder, run:

   ```powershell
   Copy-Item .env.example .env
   npm install
   npm start
   ```

3. Open `http://localhost:3000` or `http://<this-PC-LAN-IP>:3000` on your home network. Allow Node.js through Windows Firewall for private networks if prompted.
4. Visit `/admin` to connect Plex with its PIN sign-in, choose your server and libraries, configure TMDB and streaming services, and manage voting. Manual Plex token and server URL entry remains available as a fallback.

The server binds to `0.0.0.0` on port 3000 by default. Set `PORT` in `.env` to change it. App data is stored in `data/watch-night.sqlite`.

## TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
