# Candymates

Online multiplayer match-3 for up to 4 mates, all on one shared candy board. Play it at **https://zakrowling.github.io/candymates/** or jump straight into the shared room at **https://zakrowling.github.io/candymates/mate**.

- **One shared board**: everyone swaps on the same 16×10 board (as wide as the Pacmates maze) at the same time. Glossy boiled-sweet candies: strawberry hearts, peach drops, lemon stars, mint chews, blueberry gumdrops and lavender gems. Buttons, scores and the clock are little wrapped sweets. Line up 3 or more matching candies to clear them; the points go to whoever made the swap, including every cascade it sets off. Grab the good moves before your mates do, or ruin their set-ups.
- **Head to head**: highest score after 3 minutes wins. A short "Ready?" countdown starts each game, the clock turns red for the last 10 seconds with a tick every second, and a tied top score is a draw.
- **Special candies**:
  - Match **4 in a row**: striped candy. When it's cleared it wipes out its whole row or column.
  - Match an **L or T** shape: wrapped candy. Blasts the 3×3 around it.
  - Match **5 in a row**: colour bomb (a chocolate ball with sprinkles). Swap it with any candy to clear every candy of that colour.
  - **Combos**: swap two specials together. Two striped: a row and a column. Striped + wrapped: three rows and three columns. Two wrapped: a 5×5 blast. Colour bomb + striped/wrapped: every candy of that colour becomes that special and goes off. Two colour bombs: the whole board.
- **Cascades**: candies fall into the gaps and new ones drop in from the top. Each cascade level multiplies the points (×2, ×3…). If the board runs out of moves it's reshuffled.
- **See your mates**: everyone's mouse pointer glides live across the board as a little arrow in their colour with their name, the sweet they're over glows in their colour (and fills when they've picked it), and points pop up in the colour of the player who scored them.
- **Controls**: drag a candy onto a neighbour, or click one candy then a neighbour. Works with touch too. Keyboard: arrows to move, Space or Enter to pick a candy, then an arrow to swap it that way.
- **Room codes**: create a room and share the 4-letter code (e.g. `WFTF`) or the invite link. Friends can join a game that's already running.
- **Link rooms**: share a link like https://zakrowling.github.io/candymates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over hosting, so the room stays open while anyone is in it. Any 2–16 letters, numbers or dashes work as a room name.
- **Sound**: a different background track each round, quietly during play: Sugar Rush, then Cotton Confetti, then Playful Pastries, then back to the start ([`public/assets/audio/`](public/assets/audio/)). Every player hears the same track for that round. It follows the shared game clock so every player hears the same part, fades in and out, and crossfades into itself at the end so the loop feels continuous. Effects are synthesized with Web Audio and kept kawaii: "pi-pu!" chirps and little bells that climb a scale with each cascade, a twinkle when you make a special, a sparkly swish for striped candies, a springy boing for wrapped ones, a rainbow glissando for colour bombs, and countdown ticks.

## How it works

There is no game server. Candymates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the game engine ([`public/engine.js`](public/engine.js)) and the board rules ([`public/board.js`](public/board.js)): matches, specials, cascades, scores and the clock. Other players only send "swap these two candies" (and where their pointer is), so their browsers can't change the board or scores.
- Each swap is checked against the candies actually on the board (by id), so a swap made on a board that has just changed is refused rather than swapping the wrong candies.
- The host sends each swap as a list of steps (what was cleared, then the board after candies fall). Every player's browser animates those steps in order, so everyone sees the same thing even when several people swap at once.
- Players connect to the host over WebRTC using [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)). PeerJS's free cloud server only introduces players to each other; game traffic goes directly between browsers.
- Some browser pairs and networks can't connect directly (e.g. Firefox ↔ Chrome, phones on mobile data, strict work networks). For those, add a free relay (TURN) server: sign up at [Metered Open Relay](https://www.metered.ca/tools/openrelay/) and paste your credentials URL into `turnCredentialsUrl` in [`public/config.js`](public/config.js).

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 (or http://localhost:3000/mate for the link room). To play locally, create a room in one browser window and join with the code from another window or device. An internet connection is still needed to reach the PeerJS service.

## Test

```bash
npm test
```

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

## Assets

Everything is drawn in code, and sound effects are synthesized; the background music is in `public/assets/audio/`. Drop an optional logo at `public/assets/image/candymates-logo.png`; see [`public/assets/README.md`](public/assets/README.md).
