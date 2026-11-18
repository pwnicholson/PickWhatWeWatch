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
4. Visit `/admin` to connect Plex with its PIN sign-in, choose your server and libraries, configure TMDB, streaming services, optional OMDb and content-rating filters, then manage voting. The admin can lock guest shortlist additions, search and add titles directly to the Standard shortlist, and limit search, fill, and ballots to Movies, TV Shows, or both without deleting stored items. Standard Mode uses a capped curated shortlist; **Build the List Together** uses a separate candidate pool and runs a rapid Yes/No Round 1 followed by the same ranked-choice ballot for finalists. Round 1 creates a pool of six titles per finalist as an editable draft; the admin can optionally seed it from a copy of the Standard shortlist, remove titles, refill vacancies, and release the pool when ready. Live progress tracks guest votes after release. Set the Standard shortlist capacity from 3 to 100 and use **Fill Shortlist** to add randomized titles matching selected genres, eras, providers and runtime limits. Fill uses era-specific TMDB vote-count minimums (or 1,500 Movie / 1,000 TV votes for any era) and requires an average of 8.0 or higher for TMDB results and rated Plex titles; the selected maximum runtime includes a five-minute buffer. Rating filters apply to both Plex and streaming search results; TMDB US certifications are fetched only when needed. Shortlist cards show available credits and critic scores. Sync displays cached Movie and TV Show counts; Plex matches appear above streaming-only search results. Manual Plex token and server URL entry remains available as a fallback.

The server binds to `0.0.0.0` on port 3000 by default. Set `PORT` in `.env` to change it. On Windows, app data is stored in `%LOCALAPPDATA%\PickWhatWeWatch\watch-night.sqlite`; an existing `data\watch-night.sqlite` is migrated there on first start. Other platforms keep data under `data/`.

The local `data/imdb_top_250.json` file maps IMDb IDs to ranks and can be extended with additional licensed entries.

Admin tools include named shortlist snapshots with replace/append recall, CSV export, Plex Watchlist import/push, and Plex playlist creation for local titles. The Import List dialog also matches pasted title lists and uploaded CSV files against the synced Plex library first, then active TMDB streaming providers.

Streaming provider choices include paid subscriptions and library/public services such as Kanopy, Hoopla, The Criterion Channel, BritBox, Acorn TV, PBS, and PBS Masterpiece. TMDB discovery and provider matching include both `flatrate` and `free` availability.

If running the project source while an installed copy is under `Program Files`, stop the installed app and start from this folder with its existing environment file:

```powershell
$env:PWW_ENV_PATH = 'C:\Program Files (x86)\PickWhatWeWatch\.env'
npm start
```

## TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
