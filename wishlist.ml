# Pick What We Watch — Feature Wishlist & Roadmap

A living backlog of planned features, distribution improvements, and future enhancements for **Pick What We Watch**.

---

## Distribution, Packaging & Legal Compliance

- [ ] **Legal Disclaimers & Attribution Footer:**
  - Add required TMDB attribution notice (*"This product uses the TMDB API but is not endorsed or certified by TMDB"*) alongside the TMDB logo.
  - Clarify that *Pick What We Watch* is an independent, unofficial community tool not affiliated with or endorsed by Plex Inc., Jellyfin, TMDB, or OMDb, and that all posters, metadata, and trademarks belong to their respective owners.
  - Include a `THIRD-PARTY-NOTICES.md` / **About & Licenses** modal crediting open-source libraries (`express`, `better-sqlite3`, etc.).
- [ ] **GitHub README & Documentation Overhaul:**
  - Rewrite `README.md` with a clear elevator pitch, feature overview, screenshots, and a step-by-step **Quick Start** guide.
- [ ] **Windows & macOS Desktop Installers (Electron / Tauri):**
  - Package native `.exe` (Windows) and `.dmg` (macOS) installers with a custom application icon.
  - Store the SQLite database in the OS user-data directory (`%APPDATA%` / `~/Library/Application Support`) so updates preserve user data.
  - **First-Run Setup:** Prompt the user to set an Admin PIN on initial launch.
  - **System Tray / Menu Bar Mode:** Support running minimized in the Windows system tray / macOS menu bar with an optional **"Launch at System Startup"** toggle.
- [ ] **Admin PIN Reset Mechanism & Docs:**
  - Add a local `--reset-pin` CLI flag and a **"Reset Admin PIN"** option in the local system tray/menu bar menu (accessible only on the host machine), plus clear recovery steps in the README.
- [ ] **Full Config & Data Backup / Restore (`.json`):**
  - One-click **Export Full Backup** and **Restore Backup** in `[Setup Sources]` to easily migrate settings, saved shortlists, and watch history between machines or upgrades.

---

## Media Sources & Poster Handling

- [ ] **Prioritize Local Plex (or Jellyfin, etcc) Content by Default:**
  - Titles matched to a local Plex library should default to pulling the user's custom/local Plex poster (`{plexUrl}{thumb}?X-Plex-Token={token}`) whenever available, falling back to TMDB only when no local Plex artwork exists.
  - Use local Plex library default for pulling the user's custom/local Plex data for genres, actors, directors, etc. whenever available, falling back to TMDB only when no local Plex data exists.
- [ ] **Jellyfin & Media Server Competitor Support:**
  - Add modular media-server connectors for **Jellyfin**, **Emby**, and **Kodi** alongside Plex so self-hosters running alternative media servers can sync libraries, collections/tags, posters, and deep links.
  - Pull genres, 


---

## Voting Experience & Spoiler Controls

- [ ] **QR Code Instant Couch Join (`/admin` & `/vote`):**
  - Display a locally generated QR code on `/admin` pointing to the LAN `/vote` URL so guests can scan the screen with their phones and jump straight into voting.
- [ ] **"Bonus Round!" Head-to-Head Tie-Breaker + Coin Toss:**
  - When two titles tie for #1 on `/results`, give the group two options:
    1. **Launch Bonus Round:** Open a quick head-to-head runoff ballot featuring *only* the tied contenders.
    2. **Coin Toss / Spin Wheel:** Settle the tie immediately via a randomized coin toss or spin wheel (also offered automatically if the Bonus Round itself ends in a tie).
- [ ] **Spoiler-Free Mode (Optional "No Posters"):**
  - Add an optional admin toggle (default: **Off**) for **"Hide Posters (No-Spoiler Mode)"** to conceal cover art during voting when desired.
- [ ] **In-App Trailer Previews (`/vote`):**
  - Add a **"Watch Trailer"** button on ballot cards that opens an embedded YouTube trailer modal (via TMDB's `/videos` endpoint) so undecided voters can preview a title without leaving the app.
- [ ] **Direct "Watch Now" Deep Links (`/results`):**
  - Add a direct **"Open in Plex / Jellyfin"** button (launching the title's server web URL) or **"Where to Watch"** link on the winning card in `/results`.
  [ ] **Clarify Scores:**
  - Separate ratings so Metacritic & RT are on a line that says "Critics:" and IMDB is ona line that says "Audience:" 
  - Add TMDB audience scores to the "Audience" line
  [ ] **Genres:**
  - Add "Musicals" and "History" to genres.
  - Consider merging "Action and Adventure".
  [ ] **Exclusionary Filters:**
  - Offer the ability to have "include" and "exclude" for each genre so you can search for things that are "Sci-fi" but NOT "Action", as an example.
  [ ] **Checkboxes for Content Ratings:**
  - Allow admin to select which content ratings they want included (so you can say only PG-13 and R, not G/PG, for example)
  
  

---

## Watch History, Ratings & Smart Recommendations

- [ ] **Offer Suggestion Sources:**
  - Offer suggestion sources like IMDB 250, list of Oscar Winners, Oscar Nominees, Letterboxd Top 500 Films, Metacritic top films, etc.
- [ ] **Explicit "Mark as Watched" & Permanent Exclusion:**
  - Never assume a vote winner was actually watched. Instead, add a **"Mark as Watched"** button on shortlist items (and on `/results`) that removes the title from the active shortlist and logs it to a `watch_history` exclusion list so **Auto-Fill** never recommends it again.
- [ ] **"Never Recommend / Dislike" & Post-Watch Quick Rating:**
  - Add a **"Never Recommend"** button directly on shortlist items.
  - When an admin marks a movie as **Watched**, pop up a lightweight **"What did you think?"** prompt (**Thumbs Up** / **Thumbs Down** / **Skip**).
- [ ] **Algorithmic "Taste-Aware" Auto-Fill (with "Surprise Me" Toggle):**
  - Use logged Thumbs Up / Thumbs Down signals (weighting overlapping genres, eras, stars, content ratings, and directors) to bias **Auto-Fill** suggestions toward what the group enjoys—while preserving a **"Surprise Me (True Random)"** toggle so users are never locked into a filter bubble.
- [ ] **"Tune Your Algorithm" Calibration Mode:**
  - Provide an interactive rapid-rating deck (curated across a broad, intentional mix of eras, genres, and styles—not random) where users can mark **Thumbs Up**, **Thumbs Down**, or **Haven't Seen** to quickly train preferences.
  - **Phase 1 (Household Store):** Store all ratings in a single shared household preference profile.
  - **Phase 2 (Multi-User Profiles & Session Blending):** Allow individual household members to maintain separate taste profiles and let the admin select **"Who's watching tonight?"** so Auto-Fill prioritizes overlapping tastes across tonight's specific viewers.

---

## Free / Low-Cost Cloud Hosting Exploration

- [ ] **Static "Bring Your Own Key" (BYOK) Lite Web Edition:**
  - Explore a zero-cost hosted mode (deployable on GitHub Pages or static web hosting) where rooms sync peer-to-peer via WebRTC (`PeerJS`) or a free-tier realtime store (Firebase/Supabase) and hosts supply their own TMDB key in `localStorage`.
- [ ] **Capped Multi-Room Free Tier Hosting (Fly.io / Render / Railway):**
  - Explore hosting the full Node + SQLite app with temporary room codes (`/?room=ABCD`) and hard concurrency/rate caps so hosting costs remain `$0` even if traffic spikes.