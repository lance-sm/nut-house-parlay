# Nut House Bozo Parlay

Live tracker for the Nut House weekly six-leg parlay. Scores come from ESPN's public scoreboard and refresh every 20 seconds while a game is on.

## Each week

1. Tap **New parlay**, search each team, pick the side and line, and add the leg.
2. Tap **Save**, then **Share** and drop the link in the group chat. Anyone who opens it gets the ticket saved on their phone.
3. Tap any leg for the full game: score by quarter, win probability, box score, player stats, scoring plays and drives.

## Season log

`parlays.json` holds every week's ticket so the season record shows for everyone at the plain link. Outcomes aren't stored; they're recomputed from ESPN's final scores.

## Running it locally

```bash
python3 -m http.server 8642
```

Then open http://localhost:8642.
