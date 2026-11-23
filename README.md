# Pick What We Watch

**Stop scrolling for 45 minutes and actually watch something.**  
*Pick What We Watch* is a self-hosted, local-first web and desktop application that helps households, roommates, and watch parties quickly decide on a movie or TV show together.

Connect your personal **Plex Media Server**, your **streaming subscriptions** (via TMDB), or both—filter by tonight's mood, runtime, rating, or era, and let everyone rank their favorites on their phones.

---

## Key Features

- **Two Flexible Voting Modes:**
  - **Standard Mode (Ranked-Choice Ballot):** Curate a shortlist and let everyone rank their top picks from their own phone or browser.
  - **Build the List Together (2-Round Mode):** Start with a larger pool of candidates (`Finalists × 6`), have everyone swipe/vote **Yes or No** in Round 1 to narrow down the top contenders, and finish with a ranked-choice finale in Round 2.
- **Smart Source Integration:**
  - **Plex Media Server (Optional):** Sign in with Plex OAuth, select specific libraries and labels, and sync movies or TV shows directly from your personal server—or push winning picks straight to your Plex Watchlist or a custom Plex Playlist.
  - **Streaming Services via TMDB (Optional):** Auto-fill and search across major subscription and library services (Netflix, Max, Disney+, Hulu, Prime Video, Apple TV+, Paramount+, Peacock, Criterion Channel, Kanopy, Hoopla, BritBox, Acorn TV, PBS, and more).
  - **Critic Ratings via OMDb (Optional):** Enrich titles with Rotten Tomatoes / Metacritic / IMDb critic scores.
- **Dynamic Session Filters:**
  - Keep a long master shortlist and slice it live for tonight's session by **Media Type** (Movies, TV, or Both), **Content Rating**, **Genres**, **Eras/Decades**, and **Runtime**—non-matching titles dim automatically in the admin panel without being deleted.
- **Spoiler-Aware Voting & Saved Lists:**
  - Plot descriptions are hidden by default behind a **Show Description** toggle so voters aren't spoiled while browsing.
  - Save, load, append, import (CSV/text), and export shortlists anytime.
- **Windows Desktop App & System Tray Support:**
  - Runs as a native Windows desktop application with a system tray menu, optional launch at Windows startup, and local LAN access so anyone on your Wi-Fi can join from their phone.

---

## Getting Started

### Option 1: Windows Installer (Recommended)
1. Download the latest **`Pick What We Watch Setup 1.0.0.exe`** from the [Releases](../../releases) page.
2. Run the installer *(if Windows SmartScreen prompts you, click **More info** → **Run anyway**)*.
3. On first launch, create your **Admin PIN** when prompted.
4. Open the **Setup Sources** tab in the Admin Dashboard to connect your Plex server and/or enter your free **TMDB** and **OMDb** API keys.
5. Share the local network voting URL (e.g., `http://<your-pc-ip>:3000/vote`) with everyone in the room so they can vote from their phones!

> **Tip:** Closing the desktop window minimizes *Pick What We Watch* to your Windows System Tray so your voting server stays online in the background. Right-click the tray icon to reopen Admin, open the Voter Ballot, toggle **Start Minimized on Windows Boot**, or quit.

---

### Option 2: Run from Source (Node.js)

**Prerequisites:** [Node.js](https://nodejs.org/) (v18 or newer)

1. Clone the repository and install dependencies:
   ```bash
   git clone [https://github.com/](https://github.com/)<your-username>/PickWhatWeWatch.git
   cd PickWhatWeWatch
   npm install