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
4. Visit `/admin` to connect Plex with its PIN sign-in, choose your server and libraries, configure TMDB, streaming services, optional OMDb and content-rating filters, then manage voting. Rating filters apply to both Plex and streaming search results; TMDB US certifications are fetched only when needed. Shortlist cards show available credits and critic scores. Sync displays cached Movie and TV Show counts; Plex matches appear above streaming-only search results. Manual Plex token and server URL entry remains available as a fallback.

The server binds to `0.0.0.0` on port 3000 by default. Set `PORT` in `.env` to change it. On Windows, app data is stored in `%LOCALAPPDATA%\PickWhatWeWatch\watch-night.sqlite`; an existing `data\watch-night.sqlite` is migrated there on first start. Other platforms keep data under `data/`.

The local `data/imdb_top_250.json` file maps IMDb IDs to ranks and can be extended with additional licensed entries.

If running the project source while an installed copy is under `Program Files`, stop the installed app and start from this folder with its existing environment file:

```powershell
$env:PWW_ENV_PATH = 'C:\Program Files (x86)\PickWhatWeWatch\.env'
npm start
```

## TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
