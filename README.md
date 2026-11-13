# Nut House Bozo Parlay

Live tracker for the Nut House weekly six-leg parlay. Scores come from ESPN's public scoreboard and refresh every 20 seconds while a game is on.

## Each week

1. Tap **New parlay**, search each team, pick the side and line, and add the leg.
2. Tap **Save**, then **Share** and drop the link in the group chat. Anyone who opens it gets the ticket saved on their phone.
3. Tap any leg for the full game: score by quarter, win probability, box score, player stats, scoring plays and drives.

## Season log

`parlays.json` holds every week's ticket so the season record shows for everyone at the plain link. Outcomes aren't stored; they're recomputed from ESPN's final scores.

## Lab tab

The **Lab** tab lists every P4 and G6 game in the week ESPN is on, searchable by team and filterable by tier, conference, day and line. It ranks a **Best bets** board (spreads and totals) and a **Safest legs** board (short moneylines) from our own model, not from anyone's picks:

- **Nut House Line** (`js/model.js`): power ratings fit on this season's results and on the closing lines, blended 35% results, 65% market. It sets our line and breaks ties; on its own it doesn't beat closing numbers.
- **Spots** (`js/lab-core.js`): letdown, hype, buy-low, rest, home-dog and bowl-push angles, each graded week by week only on games before the week on screen, so a spot moves the price only once it has a record.
- **House book**: what this crew hits by bet type and by player, from `data/history.json`, shown on every pick as a bozo-risk chip.

Check the model against closing lines, walk-forward:

```bash
node scripts/backtest_model.mjs            # ratings vs closing lines
node scripts/backtest_model.mjs --board    # the Lab's boards, week by week
```

Everything it shows is an estimate.

## Running it locally

```bash
python3 -m http.server 8642
```

Then open http://localhost:8642.

## Cache busting

Every script/style URL carries `?v=<stamp>` (index.html and every `import` in js/). When you change any JS or CSS, bump the stamp everywhere in one go so phones don't mix old and new files:

```bash
sed -i '' -E 's/\?v=[0-9a-z]+/?v=NEWSTAMP/g' index.html js/*.js
```
